import type MongoProvider from "@providers/object/mongo/index.js";
import type RabbitMQProvider from "@providers/queue/rabbitmq/index.js";
import type { IHostBasedHttpProvider } from "@interfaces/modules/providers/IHttpServer.d.ts";
import { BaseService } from "@services/BaseService.js";
import { Kernel } from "@kernel";
import { NOTIFY_SERVICE, NOTIFY_OPERATION, NOTIFY_BROADCAST_OPERATION } from "@common/utils/notifications/emit.ts";
import { forEachPage } from "@common/utils/batch.ts";
import type { IIdentityManagerService } from "@common/types/identity/IIdentityManagerService.js";
import { EnableEndpoints, DisableEndpoints } from "@services/core/EndpointManagerService/index.js";
import { OnlyKernel } from "@adc/utils/decorators/OnlyKernel.ts";
import type { ISessionVerifier } from "@common/types/identity/SessionVerifier.ts";
import type { INotificationService, INotificationEmailSender } from "@common/types/notifications/INotificationService.ts";
import type { BroadcastInput, Notification, NotificationPreference, NotifyInput } from "@common/types/notifications/Notification.ts";
import { NotificationError } from "@common/types/custom-errors/NotificationError.ts";
import { assertScope, Scope, type CapabilityToken } from "@common/security/Capability.ts";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { notificationSchema, notificationSecretSchema, preferenceSchema, type NotificationSecret } from "./domain/index.ts";
import { NotificationManager, PreferenceManager } from "./dao/index.ts";
import { SYSTEM_TOPIC_TEMPLATES, isReservedTopic, RateLimiter } from "./policy.ts";
import { SseHub } from "./sse/SseHub.ts";
import { registerSseRoute } from "./sse/registerSseRoute.ts";
import { NotificationEndpoints } from "./endpoints/notifications.ts";
import { PreferenceEndpoints } from "./endpoints/preferences.ts";

const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Tamaño de página del fan-out de broadcasts (por chunk de cola y por página directa). */
const BROADCAST_CHUNK = 50;

/**
 * Mensaje de la cola `broadcast`: el anuncio + el progreso del fan-out. Cada chunk
 * procesa UNA página y re-publica con el cursor avanzado (reanudable, reintentos
 * frescos por chunk). SOLO este servicio publica acá, firmando cada job: un mensaje
 * inyectado por otro módulo no verifica y se descarta.
 */
interface BroadcastJob extends BroadcastInput {
	/** Último userId procesado; ausente = primera página. */
	cursor?: string | null;
	/** Usuarios alcanzados por los chunks anteriores. */
	delivered?: number;
	/** HMAC-SHA256 (hex) del payload canónico. */
	sig?: string;
}

/**
 * Servicio de notificaciones: bandeja por usuario (Mongo, base `adc-notifications`),
 * preferencias por topic/canal, entrega en tiempo real por SSE y canal email
 * opcional (si `EmailService` está cargado). Productores emiten vía `notify()`.
 */
export default class NotificationService extends BaseService implements INotificationService {
	public readonly name = "NotificationService";

	#mongo!: MongoProvider;
	#rabbit: RabbitMQProvider | null = null;
	#sessionVerifier: ISessionVerifier | null = null;

	#notifications: NotificationManager | null = null;
	#preferences: PreferenceManager | null = null;
	#hub: SseHub | null = null;
	/** Secreto HMAC (persistido en mongo) con el que se firman los jobs de broadcast. */
	#broadcastKey: Buffer | null = null;

	#systemFrom = "no-reply@adigitalcafe.com";
	#retentionDays = 90;
	#purgeTimer: NodeJS.Timeout | null = null;

	// Anti-flood por (usuario, topic): general laxo; reservados (security.*) estricto.
	readonly #generalLimiter = new RateLimiter(30, 60_000);
	readonly #securityLimiter = new RateLimiter(5, 3_600_000);

	constructor(kernel: Kernel, options?: ConstructorParameters<typeof BaseService>[1]) {
		super(kernel, options);
	}

	@EnableEndpoints({ managers: () => [NotificationEndpoints, PreferenceEndpoints] })
	async start(kernelKey: symbol): Promise<void> {
		await super.start(kernelKey);

		this.#mongo = this.getMyProvider<MongoProvider>("object/mongo");
		await this.#waitForMongo();

		const priv = (this.config?.private ?? {}) as Record<string, string | undefined>;
		const dbName = priv.dbName || "adc-notifications";
		this.#systemFrom = priv.systemFrom || this.#systemFrom;
		this.#retentionDays = Number(priv.retentionDays || 90) || 90;

		// Vista lógica aislada sobre la conexión Mongo de la plataforma.
		const db = this.#mongo.useDb(this.#mongo.getConnection(), dbName);
		const NotificationModel = this.#mongo.createModelForDb<Notification>(db, "notifications", notificationSchema);
		const PreferenceModel = this.#mongo.createModelForDb<NotificationPreference>(db, "notification_preferences", preferenceSchema);

		this.#notifications = new NotificationManager(NotificationModel);
		this.#preferences = new PreferenceManager(PreferenceModel);
		this.#hub = new SseHub(this.logger);

		// Secreto de firma de broadcasts: se crea una sola vez y persiste entre reinicios.
		const SecretModel = this.#mongo.createModelForDb<NotificationSecret>(db, "notification_secrets", notificationSecretSchema);
		const secret = await SecretModel.findOneAndUpdate(
			{ _id: "broadcast-hmac" },
			{ $setOnInsert: { key: randomBytes(32).toString("hex"), createdAt: new Date() } },
			{ upsert: true, new: true }
		).lean();
		this.#broadcastKey = secret ? Buffer.from(secret.key, "hex") : null;

		// Endpoint SSE sobre el socket crudo (no encaja en @RegisterEndpoint).
		const httpProvider = this.getMyProvider<IHostBasedHttpProvider>("fastify-server");
		registerSseRoute({
			httpProvider,
			hub: this.#hub,
			getVerifier: () => this.#getSessionVerifier(),
			getUnreadCount: (userId: string) => this.notifications.unreadCount(userId),
			logger: this.logger,
		});

		NotificationEndpoints.init(this, kernelKey);
		PreferenceEndpoints.init(this, kernelKey);

		// Cola durable: los productores publican aquí vía `emitNotification`; si este
		// servicio está en mantenimiento, los mensajes se acumulan y se entregan al
		// reconectar el consumidor (entrega eventual). Degradación: sin cola, los
		// productores caen a entrega directa vía `notify()`.
		await this.#setupQueueConsumer();

		this.#startPurgeScheduler();
		this.logger.logOk("NotificationService iniciado");
	}

	@DisableEndpoints()
	async stop(kernelKey: symbol): Promise<void> {
		await super.stop(kernelKey);
		if (this.#purgeTimer) clearInterval(this.#purgeTimer);
		this.#purgeTimer = null;
		this.#broadcastKey = null;
		this.#hub?.stop();
		this.logger.logOk("NotificationService detenido");
	}

	// ─── API de productores (INotificationService) ──────────────────────────
	/**
	 * Entrega directa de una notificación (canal inApp + email/push según prefs).
	 * Es la implementación de `INotificationService.notify`: la usa el fallback
	 * síncrono de `emitNotification` cuando la cola no está disponible, y también
	 * el consumidor de la cola (vía `#deliver`). Preferí **`emitNotification`** en
	 * los productores (desacoplado y durable) en vez de llamar esto directo.
	 */
	async notify(input: NotifyInput): Promise<void> {
		return this.#deliver(input);
	}

	/**
	 * Anuncio a TODOS los usuarios activos: la única puerta de entrada de broadcasts.
	 * Exige el scope `notifications:broadcast` en la capability; con cola encola UN
	 * job firmado (`queued`), sin cola hace fan-out directo (`direct`).
	 */
	async broadcast(cap: CapabilityToken, input: BroadcastInput): Promise<"queued" | "direct"> {
		assertScope(cap, Scope.NotificationsBroadcast);
		if (!input.broadcastId) throw new NotificationError(400, "MISSING_FIELDS", "broadcastId requerido");
		if (this.#rabbit && this.#broadcastKey) {
			await this.#publishBroadcastJob({ ...input, cursor: null, delivered: 0 });
			return "queued";
		}
		await this.#directBroadcast(input);
		return "direct";
	}

	// ─── Fan-out de broadcasts ──────────────────────────────────────────────
	/** Payload canónico de la firma: los campos que definen el anuncio y su progreso. */
	#broadcastPayload(job: BroadcastJob): string {
		return JSON.stringify([
			job.broadcastId,
			job.topic,
			job.title,
			job.body,
			job.link ?? null,
			job.linkApp ?? null,
			job.icon ?? null,
			job.data ?? null,
			job.cursor ?? null,
			job.delivered ?? 0,
		]);
	}

	#signBroadcastJob(job: BroadcastJob): string {
		if (!this.#broadcastKey) throw new NotificationError(503, "TRANSPORT_UNAVAILABLE", "Clave de firma de broadcasts no inicializada");
		return createHmac("sha256", this.#broadcastKey).update(this.#broadcastPayload(job)).digest("hex");
	}

	/** `true` sólo si el job trae una firma HMAC válida de ESTE servicio. */
	#verifyBroadcastJob(job: BroadcastJob): boolean {
		if (!this.#broadcastKey || !job.broadcastId || typeof job.sig !== "string") return false;
		const expected = Buffer.from(this.#signBroadcastJob(job), "hex");
		const actual = Buffer.from(job.sig, "hex");
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	}

	/** Firma y publica un job de broadcast en la cola durable. */
	async #publishBroadcastJob(job: BroadcastJob): Promise<void> {
		if (!this.#rabbit) throw new NotificationError(503, "TRANSPORT_UNAVAILABLE", "Cola de broadcasts no disponible");
		const signed: BroadcastJob = { ...job, sig: this.#signBroadcastJob(job) };
		await this.#rabbit.publish(NOTIFY_SERVICE, NOTIFY_BROADCAST_OPERATION, signed as unknown as Record<string, unknown>);
	}

	/** Fan-out inmediato sin cola (modo degradado de `broadcast()`). */
	async #directBroadcast(input: BroadcastInput): Promise<void> {
		let failed = 0;
		const total = await forEachPage(
			async (afterId, limit) => (await this.#fetchUserIdsPage(afterId, limit)).map((id) => ({ id })),
			async (page) => {
				failed += await this.#deliverBroadcastPage(
					input,
					page.map((u) => u.id)
				);
			},
			BROADCAST_CHUNK
		);
		if (failed > 0) this.logger.logWarn(`broadcast ${input.broadcastId} (directo): ${failed}/${total} entregas fallaron`);
		else this.logger.logOk(`broadcast ${input.broadcastId} (directo) completado: ${total} usuario(s)`);
	}

	/**
	 * Procesa UN chunk: entrega una página y re-publica (re-firmado) con el cursor
	 * avanzado si quedan más. Si alguna entrega falla, lanza: la cola reintenta y el
	 * dedup saltea a los ya alcanzados. Un job sin firma válida se descarta (un
	 * reintento nunca lo volvería válido).
	 */
	async #processBroadcastChunk(job: BroadcastJob): Promise<void> {
		if (!this.#verifyBroadcastJob(job)) {
			this.logger.logWarn(
				`broadcast descartado: job sin firma válida (broadcastId=${job.broadcastId ?? "?"}, origin=${job.origin ?? "?"})`
			);
			return;
		}
		const ids = await this.#fetchUserIdsPage(job.cursor ?? null, BROADCAST_CHUNK);
		const delivered = (job.delivered ?? 0) + ids.length;
		if (ids.length > 0) {
			const failed = await this.#deliverBroadcastPage(job, ids);
			if (failed > 0) throw new Error(`broadcast ${job.broadcastId}: ${failed}/${ids.length} entregas fallaron en el chunk`);
		}
		if (ids.length === BROADCAST_CHUNK) {
			await this.#publishBroadcastJob({ ...job, cursor: ids.at(-1), delivered });
		} else {
			this.logger.logOk(`broadcast ${job.broadcastId} completado: ${delivered} usuario(s)`);
		}
	}

	/** Entrega una página del broadcast; devuelve cuántas entregas fallaron. */
	async #deliverBroadcastPage(input: BroadcastInput, userIds: string[]): Promise<number> {
		const results = await Promise.allSettled(
			userIds.map((userId) =>
				this.#deliver(
					{
						userId,
						topic: input.topic,
						title: input.title,
						body: input.body,
						origin: input.origin,
						icon: input.icon,
						link: input.link,
						linkApp: input.linkApp,
						data: input.data,
					},
					input.broadcastId
				)
			)
		);
		return results.filter((r) => r.status === "rejected").length;
	}

	/** Página de IDs de usuarios activos (`id > afterId`, ascendente) vía identity interna. */
	async #fetchUserIdsPage(afterId: string | null, limit: number): Promise<string[]> {
		const internal = this.#identityInternal();
		if (!internal) {
			throw new NotificationError(503, "TRANSPORT_UNAVAILABLE", "IdentityManagerService no disponible para enumerar destinatarios");
		}
		return internal.users.getUserIdsPage(afterId, limit);
	}

	/**
	 * Política de seguridad en el choke point de entrega (cubre cola + entrega directa):
	 *  1. **Topics reservados** (`security.*`): deben tener plantilla declarada y el
	 *     `origin` del productor debe estar allowlisted; si no, se descarta (anti-spoofing).
	 *     El contenido (title/body/link/channels) se **renderiza desde el servidor**, así
	 *     un productor no puede inyectar texto de phishing bajo un topic creíble.
	 *  2. **Rate-limit** por (usuario, topic): estricto para reservados, laxo para el resto.
	 *
	 * @returns el input efectivo a entregar, o `null` si debe descartarse.
	 */
	#applyPolicy(input: NotifyInput): NotifyInput | null {
		const { topic } = input;
		let effective = input;

		if (isReservedTopic(topic)) {
			const tpl = SYSTEM_TOPIC_TEMPLATES[topic];
			if (!tpl) {
				this.logger.logWarn(`notify: topic reservado desconocido '${topic}' descartado (origen=${input.origin ?? "?"})`);
				return null;
			}
			if (!tpl.allowedOrigins.includes(input.origin ?? "")) {
				this.logger.logWarn(`notify: origen '${input.origin ?? "?"}' no autorizado para '${topic}'; descartado (posible spoofing)`);
				return null;
			}
			// Contenido canónico del servidor: ignoramos title/body/link/channels del productor.
			effective = {
				userId: input.userId,
				topic,
				title: tpl.title,
				body: tpl.body,
				channels: tpl.channels ?? input.channels,
				linkApp: tpl.linkApp,
				link: tpl.link,
				data: input.data,
				collapseUnread: input.collapseUnread,
			};
		}

		const limiter = isReservedTopic(topic) ? this.#securityLimiter : this.#generalLimiter;
		if (!limiter.allow(`${input.userId}:${topic}`)) {
			this.logger.logDebug(`notify: rate-limit excedido (${input.userId} topic=${topic}); descartado`);
			return null;
		}
		return effective;
	}

	/** Persiste (inApp), empuja por SSE y dispara email/push según preferencias. */
	async #deliver(rawInput: NotifyInput, broadcastId?: string): Promise<void> {
		const input = this.#applyPolicy(rawInput);
		if (!input) return;

		const channels = await this.preferences.resolveChannels(input.userId, input.topic, input.channels);
		if (channels.length === 0) return;

		if (broadcastId) {
			// El doc es el registro de dedup: si ya existe, el usuario ya recibió todos los canales.
			const notification = await this.notifications.createBroadcast(input, channels, broadcastId);
			if (!notification) return;
			if (channels.includes("inApp")) {
				const unread = await this.notifications.unreadCount(input.userId);
				this.#hub?.publishToUser(input.userId, { type: "notification", unread, notification });
			}
		} else if (channels.includes("inApp")) {
			// Digest: si ya hay una no leída del mismo topic, no apilamos otra.
			const collapse = input.collapseUnread && (await this.notifications.hasUnreadForTopic(input.userId, input.topic));
			if (!collapse) {
				const notification = await this.notifications.create(input, channels);
				const unread = await this.notifications.unreadCount(input.userId);
				this.#hub?.publishToUser(input.userId, { type: "notification", unread, notification });
			}
		}

		if (channels.includes("email")) {
			await this.#deliverEmail(input).catch((e) =>
				this.logger.logWarn(`notify: canal email falló para ${input.userId}: ${(e as Error).message}`)
			);
		}

		// channel "push": modelado (queda persistido en el registro) pero entregado
		// por Web Push en una fase futura. Hoy es no-op.
	}

	/** Marca una notificación como leída y sincroniza el conteo por SSE. */
	async markRead(userId: string, id: string): Promise<number> {
		const unread = await this.notifications.markRead(userId, id);
		this.#hub?.publishToUser(userId, { type: "read", unread });
		return unread;
	}

	/** Marca todas como leídas y sincroniza por SSE. */
	async markAllRead(userId: string): Promise<void> {
		await this.notifications.markAllRead(userId);
		this.#hub?.publishToUser(userId, { type: "read", unread: 0 });
	}

	// ─── Accesores para endpoints ───────────────────────────────────────────
	get notifications(): NotificationManager {
		if (!this.#notifications) throw new NotificationError(503, "TRANSPORT_UNAVAILABLE", "Notificaciones no inicializadas");
		return this.#notifications;
	}
	get preferences(): PreferenceManager {
		if (!this.#preferences) throw new NotificationError(503, "TRANSPORT_UNAVAILABLE", "Preferencias no inicializadas");
		return this.#preferences;
	}

	/**
	 * Purga en cascada las notificaciones y preferencias de un usuario tras expirar
	 * su retención (invocado por IIdentityManagerService). Protegido por `@OnlyKernel()`.
	 */
	@OnlyKernel()
	async purgeUserData(_kernelKey: symbol, userId: string): Promise<void> {
		if (!userId) return;
		const removed = await this.notifications.purgeByUser(userId).catch(() => 0);
		await this.preferences.purgeByUser(userId).catch(() => 0);
		this.logger.logInfo(`Purga notificaciones: usuario ${userId} → ${removed} notificación(es) eliminadas`);
	}

	// ─── Internos ───────────────────────────────────────────────────────────
	/**
	 * Superficie interna de identity (scope `identity:internal`), resuelta por llamada:
	 * si IdentityManagerService se reinicia, no queda una instancia cacheada muerta.
	 */
	#identityInternal(): ReturnType<IIdentityManagerService["_internal"]> | null {
		try {
			const identity = this.getMyService<IIdentityManagerService>("IdentityManagerService");
			return identity._internal(this.getCapability());
		} catch {
			return null;
		}
	}

	/** Verificador de sesión lazy (la campana manda la cookie de sesión al SSE). */
	#getSessionVerifier(): ISessionVerifier | null {
		// SessionManagerService es dependencia declarada pero opcional en runtime (SSE → 503 si falta).
		if (!this.#sessionVerifier) {
			this.#sessionVerifier = this.tryGetMyService<ISessionVerifier>("SessionManagerService") ?? null;
		}
		return this.#sessionVerifier;
	}

	/** EmailService si está cargado e implementa `sendSystemEmail` (duck-typing). */
	#getEmailSender(): INotificationEmailSender | null {
		// EmailService es dependencia declarada pero opcional (duck-typing de `sendSystemEmail`).
		const svc = this.tryGetMyService<Partial<INotificationEmailSender>>("EmailService");
		if (svc && typeof svc.sendSystemEmail === "function") return svc as INotificationEmailSender;
		return null;
	}

	async #deliverEmail(input: NotifyInput): Promise<void> {
		const sender = this.#getEmailSender();
		if (!sender) return; // EmailService ausente o sin sendSystemEmail: se omite el canal.
		const email = await this.#resolveUserEmail(input.userId);
		if (!email) return;
		const subject = input.email?.subject ?? input.title;
		const html = input.email?.html ?? this.#defaultEmailHtml(input);
		await sender.sendSystemEmail({ to: email, subject, html, text: input.body });
	}

	async #resolveUserEmail(userId: string): Promise<string | null> {
		try {
			// Superficie interna (sin token): la pública exige un token de sesión que acá no hay.
			const user = await this.#identityInternal()?.users.getUser(userId);
			return user?.email ?? null;
		} catch {
			return null;
		}
	}

	#defaultEmailHtml(input: NotifyInput): string {
		const safe = (s: string) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c);
		const cta = input.link
			? `<p><a href="${input.link}" style="display:inline-block;padding:10px 16px;background:#5b5bd6;color:#fff;border-radius:8px;text-decoration:none">Ver</a></p>`
			: "";
		return `<div style="font-family:system-ui,sans-serif"><h2>${safe(input.title)}</h2><p>${safe(input.body)}</p>${cta}</div>`;
	}

	/** Declara la topología durable y consume los mensajes encolados por los productores. */
	async #setupQueueConsumer(): Promise<void> {
		try {
			this.#rabbit = this.getMyProvider<RabbitMQProvider>("queue/rabbitmq");
			await this.#rabbit.declareOperationTopology(NOTIFY_SERVICE, NOTIFY_OPERATION);
			this.#rabbit.createOperationConsumer(NOTIFY_SERVICE, NOTIFY_OPERATION, async (msg) => {
				await this.#deliver(msg.body as unknown as NotifyInput);
			});
			// Broadcasts: timeout holgado (un chunk entrega BROADCAST_CHUNK usuarios: mongo + SSE + email).
			await this.#rabbit.declareOperationTopology(NOTIFY_SERVICE, NOTIFY_BROADCAST_OPERATION);
			this.#rabbit.createOperationConsumer(
				NOTIFY_SERVICE,
				NOTIFY_BROADCAST_OPERATION,
				async (msg) => {
					await this.#processBroadcastChunk(msg.body as unknown as BroadcastJob);
				},
				{ jobTimeoutMs: 60_000 }
			);
			this.logger.logOk("NotificationService: consumidores de cola activos (notify + broadcast durables)");
		} catch (e) {
			this.#rabbit = null;
			this.logger.logWarn(`Cola de notificaciones no disponible; solo entrega directa: ${(e as Error).message}`);
		}
	}

	#startPurgeScheduler(): void {
		this.#purgeTimer = setInterval(() => {
			void this.notifications
				.purgeExpired(this.#retentionDays)
				.then((n) => {
					if (n > 0) this.logger.logDebug(`Purga notificaciones: ${n} leídas expiradas eliminadas`);
				})
				.catch((e) => this.logger.logWarn(`Purga notificaciones falló: ${(e as Error).message}`));
		}, PURGE_INTERVAL_MS);
		this.#purgeTimer.unref?.();
	}

	async #waitForMongo(): Promise<void> {
		const maxWaitTime = 10_000;
		const startTime = Date.now();
		while (!this.#mongo.isConnected() && Date.now() - startTime < maxWaitTime) {
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		if (!this.#mongo.isConnected()) throw new Error("MongoDB no pudo conectarse en el tiempo esperado");
	}
}
