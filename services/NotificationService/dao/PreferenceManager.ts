import type { Model } from "mongoose";
import {
	DEFAULT_CHANNELS,
	NotificationTopic,
	type NotificationChannel,
	type NotificationPreference,
} from "@common/types/notifications/Notification.ts";
import { mandatoryChannelsFor } from "@common/utils/notifications/platform-topics.ts";

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

	/**
	 * Fija/actualiza la preferencia de un topic (upsert).
	 *
	 * Los canales obligatorios de un topic de plataforma (hoy: el aviso in-app de `platform.legal`)
	 * se ignoran si vienen en `false`. El guard va acá y no en el endpoint a propósito: es el único
	 * punto por el que pasan todas las escrituras, así que un panel nuevo o un script no pueden
	 * saltárselo por olvido.
	 */
	async set(
		userId: string,
		topic: NotificationTopic,
		channels: Partial<Record<NotificationChannel, boolean>>
	): Promise<NotificationPreference> {
		const mandatory = mandatoryChannelsFor(topic);
		const $set: Record<string, unknown> = { updatedAt: new Date() };
		for (const ch of CHANNELS) {
			if (typeof channels[ch] !== "boolean") continue;
			$set[ch] = mandatory.includes(ch) ? true : channels[ch];
		}
		// Un upsert que crea la fila tiene que nacer con los obligatorios en true, aunque el body
		// no los mencione: si no, el default del insert podría dejarlos apagados.
		for (const ch of mandatory) $set[ch] = true;
		await this.#model.updateOne({ userId, topic }, { $set, $setOnInsert: { userId, topic } }, { upsert: true });
		const row = await this.#model.findOne({ userId, topic }).lean<NotificationPreference>();
		return row ?? { userId, topic, ...DEFAULT_CHANNELS, updatedAt: new Date() };
	}

	/**
	 * Resuelve los canales activos para entregar una notificación de `topic`:
	 * canales forzados por el productor, o los de la preferencia del usuario, o
	 * los `DEFAULT_CHANNELS` si no fijó preferencia.
	 *
	 * Los obligatorios se reponen también acá, en la entrega: una fila vieja escrita antes de que
	 * el topic existiera —o tocada a mano en la base— no debe poder silenciar un aviso legal.
	 */
	async resolveChannels(userId: string, topic: string, forced?: NotificationChannel[]): Promise<NotificationChannel[]> {
		if (forced && forced.length > 0) return [...new Set(forced)];
		const pref = await this.#model.findOne({ userId, topic }).lean<NotificationPreference>();
		const source = pref ?? { ...DEFAULT_CHANNELS };
		const mandatory = mandatoryChannelsFor(topic);
		return CHANNELS.filter((ch) => source[ch] === true || mandatory.includes(ch));
	}

	async purgeByUser(userId: string): Promise<number> {
		const res = await this.#model.deleteMany({ userId });
		return res.deletedCount ?? 0;
	}
}
