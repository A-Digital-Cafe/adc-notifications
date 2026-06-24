import type { Model } from "mongoose";
import {
	DEFAULT_CHANNELS,
	NotificationTopic,
	type NotificationChannel,
	type NotificationPreference,
} from "@common/types/notifications/Notification.ts";

const CHANNELS: readonly NotificationChannel[] = ["inApp", "email", "push"];

/** Preferencias de notificación por (usuario, topic) y resolución de canales. */
export class PreferenceManager {
	readonly #model: Model<NotificationPreference>;

	constructor(model: Model<NotificationPreference>) {
		this.#model = model;
	}

	/** Todas las filas de preferencia de un usuario (las que fijó explícitamente). */
	async list(userId: string): Promise<NotificationPreference[]> {
		return this.#model.find({ userId }).sort({ topic: 1 }).lean<NotificationPreference[]>();
	}

	/** Fija/actualiza la preferencia de un topic (upsert). */
	async set(
		userId: string,
		topic: NotificationTopic,
		channels: Partial<Record<NotificationChannel, boolean>>
	): Promise<NotificationPreference> {
		const $set: Record<string, unknown> = { updatedAt: new Date() };
		for (const ch of CHANNELS) {
			if (typeof channels[ch] === "boolean") $set[ch] = channels[ch];
		}
		await this.#model.updateOne({ userId, topic }, { $set, $setOnInsert: { userId, topic } }, { upsert: true });
		const row = await this.#model.findOne({ userId, topic }).lean<NotificationPreference>();
		return row ?? { userId, topic, ...DEFAULT_CHANNELS, updatedAt: new Date() };
	}

	/**
	 * Resuelve los canales activos para entregar una notificación de `topic`:
	 * canales forzados por el productor, o los de la preferencia del usuario, o
	 * los `DEFAULT_CHANNELS` si no fijó preferencia.
	 */
	async resolveChannels(userId: string, topic: string, forced?: NotificationChannel[]): Promise<NotificationChannel[]> {
		if (forced && forced.length > 0) return [...new Set(forced)];
		const pref = await this.#model.findOne({ userId, topic }).lean<NotificationPreference>();
		const source = pref ?? { ...DEFAULT_CHANNELS };
		return CHANNELS.filter((ch) => source[ch] === true);
	}

	async purgeByUser(userId: string): Promise<number> {
		const res = await this.#model.deleteMany({ userId });
		return res.deletedCount ?? 0;
	}
}
