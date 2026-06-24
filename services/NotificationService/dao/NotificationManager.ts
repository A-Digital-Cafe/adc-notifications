import { randomUUID } from "node:crypto";
import type { Model } from "mongoose";
import { NotificationError } from "@common/types/custom-errors/NotificationError.ts";
import type { Notification, NotificationChannel, NotifyInput } from "@common/types/notifications/Notification.ts";

interface ListOptions {
	limit?: number;
	/** Cursor: devuelve notificaciones creadas ANTES de esta fecha (paginación). */
	before?: Date;
}

const MAX_LIMIT = 50;

/** CRUD de la bandeja de notificaciones de cada usuario. */
export class NotificationManager {
	readonly #model: Model<Notification>;

	constructor(model: Model<Notification>) {
		this.#model = model;
	}

	/** Persiste una notificación (canal inApp). Devuelve el documento creado. */
	async create(input: NotifyInput, channels: NotificationChannel[]): Promise<Notification> {
		if (!input.userId) throw new NotificationError(400, "MISSING_FIELDS", "userId requerido");
		if (!input.topic) throw new NotificationError(400, "MISSING_FIELDS", "topic requerido");
		if (!input.title) throw new NotificationError(400, "MISSING_FIELDS", "title requerido");

		const now = new Date();
		const doc: Notification = {
			id: randomUUID(),
			userId: input.userId,
			orgId: input.orgId ?? null,
			topic: input.topic,
			title: input.title,
			body: input.body ?? "",
			icon: input.icon ?? null,
			link: input.link ?? null,
			linkApp: input.linkApp ?? null,
			data: input.data ?? null,
			channels,
			readAt: null,
			createdAt: now,
		};
		await this.#model.create(doc);
		return doc;
	}

	/** Bandeja paginada por cursor (`before`), más recientes primero. */
	async list(userId: string, opts: ListOptions = {}): Promise<Notification[]> {
		const limit = Math.min(opts.limit ?? MAX_LIMIT, MAX_LIMIT);
		const query: Record<string, unknown> = { userId };
		if (opts.before) query.createdAt = { $lt: opts.before };
		return this.#model.find(query).sort({ createdAt: -1 }).limit(limit).lean<Notification[]>();
	}

	/** Notificaciones sin leer (readAt = null). */
	async unreadCount(userId: string): Promise<number> {
		return this.#model.countDocuments({ userId, readAt: null });
	}

	/** `true` si el usuario tiene alguna notificación NO leída de ese `topic` (para colapsar/digest). */
	async hasUnreadForTopic(userId: string, topic: string): Promise<boolean> {
		return (await this.#model.exists({ userId, topic, readAt: null })) !== null;
	}

	/** Marca una notificación del usuario como leída. Devuelve el nuevo conteo de no leídas. */
	async markRead(userId: string, id: string): Promise<number> {
		const res = await this.#model.updateOne({ id, userId, readAt: null }, { $set: { readAt: new Date() } });
		if (res.matchedCount === 0) {
			const exists = await this.#model.exists({ id, userId });
			if (!exists) throw new NotificationError(404, "NOTIFICATION_NOT_FOUND", "Notificación no encontrada");
		}
		return this.unreadCount(userId);
	}

	/** Marca todas las del usuario como leídas. */
	async markAllRead(userId: string): Promise<void> {
		await this.#model.updateMany({ userId, readAt: null }, { $set: { readAt: new Date() } });
	}

	async purgeByUser(userId: string): Promise<number> {
		const res = await this.#model.deleteMany({ userId });
		return res.deletedCount ?? 0;
	}

	/**
	 * Purga sólo notificaciones **leídas** cuya **creación** (no su lectura) es más
	 * antigua que `retentionDays`. Las **no leídas se conservan indefinidamente** y
	 * leer una notificación NO acorta su vida (no se borra "X días después de leerla").
	 * `retentionDays <= 0` desactiva la purga (conservar todo).
	 */
	async purgeExpired(retentionDays: number): Promise<number> {
		if (retentionDays <= 0) return 0;
		const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
		const res = await this.#model.deleteMany({ readAt: { $ne: null }, createdAt: { $lt: cutoff } });
		return res.deletedCount ?? 0;
	}
}
