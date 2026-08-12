import type MongoProvider from "@providers/object/mongo/index.js";
import type RabbitMQProvider from "@providers/queue/rabbitmq/index.js";
import type { IHostBasedHttpProvider } from "@interfaces/modules/providers/IHttpServer.d.ts";
import { BaseService } from "@services/BaseService.js";
import { Kernel } from "@kernel";
import { NOTIFY_SERVICE, NOTIFY_OPERATION, NOTIFY_BROADCAST_OPERATION } from "@common/utils/notifications/emit.ts";
import { forEachPage } from "@common/utils/batch.ts";
import type { IIdentityManagerService } from "@common/types/identity/IIdentityManagerService.js";
import { EnableEndpoints, DisableEndpoints } from "@services/core/EndpointManagerService/index.js";
import type { ISessionVerifier } from "@common/types/identity/SessionVerifier.ts";
import type { INotificationService, INotificationEmailSender, SegmentDispatchResult } from "@common/types/notifications/INotificationService.ts";
import type {
	BroadcastInput,
	Notification,
	NotificationPreference,
	NotificationTopic,
	NotifyInput,
	SegmentInput,
	NotificationStreamEvent,
} from "@common/types/notifications/Notification.ts";
import { mandatoryChannelsFor } from "@common/utils/notifications/platform-topics.ts";
import { NotificationError } from "@common/types/custom-errors/NotificationError.ts";
import { assertScope, Scope, Capability, type CapabilityToken } from "@common/security/Capability.ts";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { notificationSchema, notificationSecretSchema, preferenceSchema, type NotificationSecret } from "./domain/index.ts";
import { createUnsubscribeToken, verifyUnsubscribeToken } from "./domain/unsubscribeToken.ts";
import { NotificationManager, PreferenceManager } from "./dao/index.ts";
import { SYSTEM_TOPIC_TEMPLATES, isReservedTopic, RateLimiter } from "./policy.ts";
import type { IClusterService } from "@common/types/cluster/ICluster.ts";
import type { IOperationsService } from "@common/types/operations/IOperationsService.ts";
import { createConnectionAffinity } from "@common/utils/connection-affinity.ts";
import { SseHub, SSE_AFFINITY_TTL_SECONDS } from "./sse/SseHub.ts";
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
	/**
	 * Audiencia explícita de este chunk (envío a subconjunto). Presente ⇒ el job entrega
	 * esos ids y termina, sin cursor ni re-publicación. Va **dentro de la firma**: si el
	 * HMAC no cubriera la audiencia, un job inyectado en la cola podría redirigir el aviso
	 * a otros destinatarios, que es justo contra lo que existe la firma.
	 */
	userIds?: string[] | null;
	/** HMAC-SHA256 (hex) del payload canónico. */
	sig?: string;
}

/** Topic del bus con el que un nodo le pasa a los demás un evento SSE para sus conexiones. */
const CLUSTER_SSE_TOPIC = "notifications.sse";

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
	#unsubscribeCluster: (() => void) | null = null;
	/** Secreto HMAC (persistido en mongo) con el que se firman los jobs de broadcast. */
	#broadcastKey: Buffer | null = null;
	/** Secreto HMAC de los enlaces de baja. Separado del anterior: distinto uso, distinta rotación. */
	#unsubscribeKey: Buffer | null = null;

	#systemFrom = "no-reply@adigitalcafe.com";
	#preferencesUrl = "https://my-account.adigitalcafe.com/";
	#unsubscribeUrl = "";
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
		this.#systemFrom = priv.systemFrom || this.#systemFrom;
		this.#preferencesUrl = priv.preferencesUrl || this.#preferencesUrl;
		this.#unsubscribeUrl = priv.unsubscribeUrl || "";
		this.#retentionDays = Number(priv.retentionDays || 90) || 90;

		// La base ya es la propia del servicio: la elige el `db` del provider en config.json.
		const NotificationModel = this.#mongo.createModel<Notification>("notifications", notificationSchema);
		const PreferenceModel = this.#mongo.createModel<NotificationPreference>("notification_preferences", preferenceSchema);

		this.#notifications = new NotificationManager(NotificationModel);
		this.#preferences = new PreferenceManager(PreferenceModel);
		// El hub publica en qué nodo está conectado cada usuario, pero NO se registra un extractor
		// de afinidad en el gateway: la entrega ya llega a cualquier nodo por el bus, y desviar el
		// endpoint SSE sería cortar un stream establecido para reabrirlo al lado. La reclamación
		// vale igual —para diagnóstico y para poder rutear algo puntual el día que haga falta—.
		this.#hub = new SseHub(this.logger, createConnectionAffinity(this.#cluster(), SSE_AFFINITY_TTL_SECONDS));
		this.#subscribeClusterStream();

		// Secretos de firma: se crean una sola vez y persisten entre reinicios. Uno por uso —
		// rotar el de los enlaces de baja no debe invalidar los broadcasts en vuelo, ni al revés.
		const SecretModel = this.#mongo.createModel<NotificationSecret>("notification_secrets", notificationSecretSchema);
		const loadSecret = async (id: string): Promise<Buffer | null> => {
			const row = await SecretModel.findOneAndUpdate(
				{ _id: id },
				{ $setOnInsert: { key: randomBytes(32).toString("hex"), createdAt: new Date() } },
				{ upsert: true, new: true }
			).lean();
			return row ? Buffer.from(row.key, "hex") : null;
		};
		this.#broadcastKey = await loadSecret("broadcast-hmac");
		this.#unsubscribeKey = await loadSecret("unsubscribe-hmac");

		// Endpoint SSE sobre el socket crudo (no encaja en @RegisterEndpoint).
		const httpProvider = this.getMyProvider<IHostBasedHttpProvider>("fastify-server");
		registerSseRoute({
			httpProvider,
			hub: this.#hub,
			getVerifier: () => this.#getSessionVerifier(),
			getUnreadCount: (userId: string) => this.notifications.unreadCount(userId),
			logger: this.logger,
			owner: this.name,
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
		// Sin esto, un handler del bus seguiría vivo tras recargar el módulo y entregaría a un
		// hub SSE ya descartado.
		this.#unsubscribeCluster?.();
		this.#unsubscribeCluster = null;
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
	async notify(input: NotifyInput, cap?: CapabilityToken): Promise<void> {
		return this.#deliver(input, undefined, cap);
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

	/**
	 * Anuncio a la audiencia enumerada. Mismo scope que `broadcast`: quien puede anunciarle a
	 * todos puede anunciarle a un subconjunto, así que no hace falta un scope nuevo.
	 *
	 * Trocea la audiencia y publica **un job firmado por chunk** (payload acotado, reintento
	 * reanudable por sí mismo, sin cursor). El dedup por `(userId, broadcastId)` hace idempotente
	 * el reintento, así que un `broadcastId` determinista permite reenviar sin duplicar.
	 */
	async notifySegment(cap: CapabilityToken, input: SegmentInput): Promise<SegmentDispatchResult> {
		assertScope(cap, Scope.NotificationsBroadcast);
		if (!input.broadcastId) throw new NotificationError(400, "MISSING_FIELDS", "broadcastId requerido");
		const userIds = [...new Set(input.userIds ?? [])].filter(Boolean);
		if (userIds.length === 0) throw new NotificationError(400, "MISSING_FIELDS", "userIds vacío: no hay a quién avisar");

		const { userIds: _audience, ...announcement } = input;
		if (this.#rabbit && this.#broadcastKey) {
			for (let i = 0; i < userIds.length; i += BROADCAST_CHUNK) {
				await this.#publishBroadcastJob({ ...announcement, userIds: userIds.slice(i, i + BROADCAST_CHUNK), delivered: 0 });
			}
			return { mode: "queued", recipients: userIds.length };
		}

		const failedUserIds: string[] = [];
		for (let i = 0; i < userIds.length; i += BROADCAST_CHUNK) {
			failedUserIds.push(...(await this.#deliverBroadcastPage(announcement, userIds.slice(i, i + BROADCAST_CHUNK))));
		}
		if (failedUserIds.length > 0) {
			this.logger.logWarn(`segmento ${input.broadcastId} (directo): ${failedUserIds.length}/${userIds.length} entregas fallaron`);
		}
		return { mode: "direct", recipients: userIds.length - failedUserIds.length, failedUserIds };
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
			job.userIds ?? null,
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
				failed += (
					await this.#deliverBroadcastPage(
						input,
						page.map((u) => u.id)
					)
				).length;
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
		// Audiencia explícita: este chunk es autosuficiente y no continúa el fan-out.
		if (job.userIds) {
			const failed = await this.#deliverBroadcastPage(job, job.userIds);
			if (failed.length > 0) throw new Error(`segmento ${job.broadcastId}: ${failed.length}/${job.userIds.length} entregas fallaron en el chunk`);
			return;
		}
		const ids = await this.#fetchUserIdsPage(job.cursor ?? null, BROADCAST_CHUNK);
		const delivered = (job.delivered ?? 0) + ids.length;
		if (ids.length > 0) {
			const failed = await this.#deliverBroadcastPage(job, ids);
			if (failed.length > 0) throw new Error(`broadcast ${job.broadcastId}: ${failed.length}/${ids.length} entregas fallaron en el chunk`);
		}
		if (ids.length === BROADCAST_CHUNK) {
			await this.#publishBroadcastJob({ ...job, cursor: ids.at(-1), delivered });
		} else {
			this.logger.logOk(`broadcast ${job.broadcastId} completado: ${delivered} usuario(s)`);
		}
	}

	/**
	 * Entrega una página del broadcast; devuelve **quiénes** fallaron, no cuántos.
	 *
	 * La lista importa donde el aviso es una obligación (un incidente de datos): el productor tiene
	 * que poder asentar el resultado por persona y reintentar sólo con quien quedó sin alcanzar.
	 */
	async #deliverBroadcastPage(input: BroadcastInput, userIds: string[]): Promise<string[]> {
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
		return userIds.filter((_, i) => results[i].status === "rejected");
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
	#applyPolicy(input: NotifyInput, cap?: CapabilityToken): NotifyInput | null {
		const { topic } = input;
		let effective = input;

		if (isReservedTopic(topic)) {
			const tpl = SYSTEM_TOPIC_TEMPLATES[topic];
			if (!tpl) {
				this.logger.logWarn(`notify: topic reservado desconocido '${topic}' descartado (origen=${input.origin ?? "?"})`);
				return null;
			}
			// El `origin` se deriva de la **capability** (infalsificable), no del payload:
			// exige capability con `identity:internal` y que su owner esté allowlisted para el
			// topic. Así un módulo comprometido no puede spoofear avisos de seguridad ni
			// inyectarlos por la cola (el consumidor entrega sin capability → se descartan).
			const owner = Capability.is(cap) && cap.has(Scope.IdentityInternal) ? cap.owner : null;
			if (!owner || !tpl.allowedOrigins.includes(owner)) {
				this.logger.logWarn(`notify: emisor '${owner ?? input.origin ?? "?"}' no autorizado para '${topic}'; descartado (posible spoofing)`);
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
				origin: owner, // origin infalsificable (de la capability), no el del payload
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
	async #deliver(rawInput: NotifyInput, broadcastId?: string, cap?: CapabilityToken): Promise<void> {
		const input = this.#applyPolicy(rawInput, cap);
		if (!input) return;

		const channels = await this.preferences.resolveChannels(input.userId, input.topic, input.channels);
		if (channels.length === 0) return;

		if (broadcastId) {
			// El doc es el registro de dedup: si ya existe, el usuario ya recibió todos los canales.
			const notification = await this.notifications.createBroadcast(input, channels, broadcastId);
			if (!notification) return;
			if (channels.includes("inApp")) {
				const unread = await this.notifications.unreadCount(input.userId);
				this.#emitToUser(input.userId, { type: "notification", unread, notification });
			}
		} else if (channels.includes("inApp")) {
			// Digest: si ya hay una no leída del mismo topic, no apilamos otra.
			const collapse = input.collapseUnread && (await this.notifications.hasUnreadForTopic(input.userId, input.topic));
			if (!collapse) {
				const notification = await this.notifications.create(input, channels);
				const unread = await this.notifications.unreadCount(input.userId);
				this.#emitToUser(input.userId, { type: "notification", unread, notification });
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

	/** Marca una notificación como leída y sincroniza por SSE; `null` = ya no estaba. */
	async markRead(userId: string, id: string): Promise<number | null> {
		const unread = await this.notifications.markRead(userId, id);
		if (unread !== null) this.#emitToUser(userId, { type: "read", unread });
		return unread;
	}

	/** Elimina una notificación de la bandeja y sincroniza por SSE; `null` = ya no estaba. */
	async deleteNotification(userId: string, id: string): Promise<number | null> {
		const unread = await this.notifications.delete(userId, id);
		// Reusa el evento "read": para las otras pestañas sólo importa el badge.
		if (unread !== null) this.#emitToUser(userId, { type: "read", unread });
		return unread;
	}

	/** Marca todas como leídas y sincroniza por SSE. Devuelve cuántas cambiaron. */
	async markAllRead(userId: string): Promise<number> {
		const changed = await this.notifications.markAllRead(userId);
		if (changed > 0) this.#emitToUser(userId, { type: "read", unread: 0 });
		return changed;
	}

	// ─── Entrega SSE entre nodos ────────────────────────────────────────────

	/**
	 * Entrega un evento a las conexiones SSE del usuario, **estén en el nodo que estén**.
	 *
	 * El hub SSE es por proceso: sólo conoce los sockets que sostiene este nodo. Con más de uno,
	 * una notificación creada en el nodo A para alguien conectado al B se perdía en silencio —
	 * el usuario la veía recién al recargar. Se entrega local y además se emite por el bus, donde
	 * cada nodo la ofrece a SUS conexiones.
	 *
	 * El bus descarta el eco propio, así que el emisor no se entrega dos veces. Y como cada nodo
	 * sólo entrega a quien tiene conectado, un evento para un usuario ausente no cuesta nada.
	 */
	#emitToUser(userId: string, event: NotificationStreamEvent): void {
		this.#hub?.publishToUser(userId, event);
		void this.#cluster()?.publish(CLUSTER_SSE_TOPIC, { userId, event });
	}

	/** Entrega local de lo que emitió otro nodo. */
	#subscribeClusterStream(): void {
		const cluster = this.#cluster();
		if (!cluster) return;
		this.#unsubscribeCluster?.();
		this.#unsubscribeCluster = cluster.subscribe<{ userId: string; event: NotificationStreamEvent }>(CLUSTER_SSE_TOPIC, (msg) => {
			const { userId, event } = msg.payload ?? {};
			if (userId && event) this.#hub?.publishToUser(userId, event);
		});
	}

	/** Opcional a propósito: sin clúster la entrega local sigue funcionando igual. */
	#cluster(): IClusterService | undefined {
		return this.tryGetMyService<IClusterService>("ClusterService");
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
	 * Export de la bandeja y las preferencias (derecho de acceso, art. 14 Ley 25.326 / art. 15
	 * RGPD). Espejo del contrato de purga, con el caller probando `identity:internal`. Acotado a
	 * las 1000 más recientes, y el JSON lo declara.
	 */
	async exportUserData(cap: CapabilityToken, userId: string): Promise<unknown> {
		assertScope(cap, Scope.IdentityInternal);
		if (!userId) return { notifications: [], preferences: [] };
		const max = 1000;
		const items = await this.notifications.exportByUser(userId, max);
		const preferences = (await this.preferences.list(userId)).map((p) => ({
			topic: p.topic,
			inApp: p.inApp,
			email: p.email,
			push: p.push,
			updatedAt: p.updatedAt,
		}));
		return {
			notifications: items.map((n) => ({
				id: n.id,
				topic: n.topic,
				title: n.title,
				body: n.body,
				link: n.link ?? null,
				linkApp: n.linkApp ?? null,
				data: n.data ?? null,
				channels: n.channels,
				readAt: n.readAt ?? null,
				createdAt: n.createdAt,
			})),
			preferences,
			truncated: items.length >= max,
			note: {
				es: `Se exportan hasta ${max} notificaciones (las más recientes) y todas las preferencias por tema.`,
				en: `Up to ${max} notifications are exported (most recent) plus all per-topic preferences.`,
			},
		};
	}

	/**
	 * Purga la bandeja y las preferencias tras la baja (cascada de Identity, scope
	 * `identity:internal`). Idempotente: un fallo lanza y el stepper reintenta sin efectos dobles.
	 */
	async purgeUserData(cap: CapabilityToken, userId: string): Promise<void> {
		assertScope(cap, Scope.IdentityInternal);
		if (!userId) return;
		const removed = await this.notifications.purgeByUser(userId);
		const prefs = await this.preferences.purgeByUser(userId);
		this.logger.logInfo(`Purga notificaciones: usuario ${userId} → ${removed} notificación(es) y ${prefs} preferencia(s) eliminadas`);
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
		// El pie de baja va SIEMPRE, también sobre html custom del productor: /privacy
		// promete que cada envío incluye cómo darse de baja.
		const html = (input.email?.html ?? this.#defaultEmailHtml(input)) + this.#emailFooter(input.topic);
		// `userId` deja que el EmailService entregue en el buzón de la plataforma
		// cuando el envío a direcciones externas está deshabilitado.
		await sender.sendSystemEmail({
			to: email,
			userId: input.userId,
			subject,
			html,
			text: input.body,
			headers: this.#unsubscribeHeaders(input.userId, input.topic),
		});
	}

	/**
	 * `List-Unsubscribe` (RFC 2369) + `List-Unsubscribe-Post` (RFC 8058): pone la baja en el
	 * botón nativo del cliente de correo, además del pie. Ganancia real de deliverability y,
	 * la forma menos hostil de ofrecerla.
	 *
	 * Se omiten cuando el email es un canal **obligatorio** del topic: anunciar una baja que
	 * el `PreferenceManager` va a ignorar es peor que no ofrecerla. Y también sin
	 * `unsubscribeUrl` configurada, porque la cabecera exige un URI absoluto y uno relativo
	 * no lo es.
	 */
	#unsubscribeHeaders(userId: string, topic: string): Record<string, string> | undefined {
		if (!this.#unsubscribeUrl || !this.#unsubscribeKey) return undefined;
		if (mandatoryChannelsFor(topic).includes("email")) return undefined;

		const token = createUnsubscribeToken({ userId, topic }, this.#unsubscribeKey);
		const sep = this.#unsubscribeUrl.includes("?") ? "&" : "?";
		return {
			"List-Unsubscribe": `<${this.#unsubscribeUrl}${sep}token=${token}>`,
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		};
	}

	/**
	 * Aplica un enlace de baja: apaga el canal email del topic firmado en el token.
	 * Devuelve el topic dado de baja, o `null` si el token no verifica o venció.
	 *
	 * Es idempotente a propósito: los clientes de correo reintentan el POST y una segunda
	 * baja del mismo topic tiene que responder lo mismo que la primera.
	 */
	async applyUnsubscribeToken(token: string): Promise<string | null> {
		if (!this.#unsubscribeKey) return null;
		const payload = verifyUnsubscribeToken(token, this.#unsubscribeKey);
		if (!payload) return null;
		await this.preferences.set(payload.userId, payload.topic as NotificationTopic, { email: false });
		this.logger.logInfo(`Baja por List-Unsubscribe: topic ${payload.topic}`);
		return payload.topic;
	}

	/** Página a la que se manda a quien abre el enlace de baja en el navegador. */
	get preferencesUrl(): string {
		return this.#preferencesUrl;
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

	/** Pie con el topic que originó el envío y el enlace a preferencias (cómo darse de baja). */
	#emailFooter(topic: string): string {
		const safe = (s: string) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c);
		return (
			`<div style="font-family:system-ui,sans-serif;margin-top:24px;padding-top:12px;border-top:1px solid #ddd;font-size:12px;color:#666">` +
			`<p>Recibís este correo por la categoría <code>${safe(topic)}</code> de tus notificaciones. ` +
			`Podés ajustarla o darte de baja de estos avisos en <a href="${this.#preferencesUrl}">tus preferencias de notificación</a>.</p>` +
			`</div>`
		);
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
			void this.#runPurge().catch((e) => this.logger.logWarn(`Purga notificaciones falló: ${(e as Error).message}`));
		}, PURGE_INTERVAL_MS);
		this.#purgeTimer.unref?.();
	}

	/**
	 * Corre `fn` sólo en el nodo que tenga el lease. Sin `OperationsService` corre igual: en un
	 * despliegue de un nodo negarse sería peor que el trabajo duplicado que evita.
	 */
	async #onlyOnLeader(name: string, ttlSeconds: number, fn: () => Promise<void>): Promise<void> {
		const ops = this.tryGetMyService<IOperationsService>("OperationsService");
		if (ops) await ops.withLeadership(name, ttlSeconds, fn);
		else await fn();
	}

	/**
	 * El barrido es un `deleteMany` idempotente: si corriera en varios nodos la segunda pasada
	 * borraría cero filas, así que el lease no evita corrupción sino pagar el mismo escaneo de
	 * la colección una vez por nodo.
	 */
	async #runPurge(): Promise<void> {
		await this.#onlyOnLeader("notifications.purge", 3600, () => this.#purgeBatch());
	}

	async #purgeBatch(): Promise<void> {
		const n = await this.notifications.purgeExpired(this.#retentionDays);
		if (n > 0) this.logger.logDebug(`Purga notificaciones: ${n} leídas expiradas eliminadas`);
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
