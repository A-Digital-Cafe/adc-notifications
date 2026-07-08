import { Schema } from "mongoose";
import type { Notification, NotificationPreference } from "@common/types/notifications/Notification.ts";

export const notificationSchema = new Schema<Notification>(
	{
		id: { type: String, required: true, unique: true, index: true },
		userId: { type: String, required: true, index: true },
		orgId: { type: String, default: null, index: true },
		topic: { type: String, required: true, index: true },
		title: { type: String, required: true },
		body: { type: String, default: "" },
		icon: { type: String, default: null },
		link: { type: String, default: null },
		linkApp: { type: String, default: null },
		data: { type: Schema.Types.Mixed, default: null },
		channels: { type: [String], default: ["inApp"] },
		broadcastId: { type: String, default: null },
		readAt: { type: Date, default: null },
		createdAt: { type: Date, default: Date.now, index: true },
	},
	{ collection: "notifications" }
);

// Bandeja de un usuario, más recientes primero.
notificationSchema.index({ userId: 1, createdAt: -1 });
// Conteo de no leídas (readAt = null).
notificationSchema.index({ userId: 1, readAt: 1 });
// Dedup de broadcasts: a lo sumo UNA notificación por (usuario, broadcast). Parcial:
// sólo aplica a docs con broadcastId string (las dirigidas llevan null y no compiten).
notificationSchema.index(
	{ userId: 1, broadcastId: 1 },
	{ unique: true, partialFilterExpression: { broadcastId: { $type: "string" } } }
);

/**
 * Secreto HMAC para firmar los jobs de broadcast en la cola. Persistido para que
 * los jobs encolados verifiquen tras un reinicio. Singleton `_id: "broadcast-hmac"`.
 */
export interface NotificationSecret {
	_id: string;
	key: string;
	createdAt: Date;
}

export const notificationSecretSchema = new Schema<NotificationSecret>(
	{
		_id: { type: String, required: true },
		key: { type: String, required: true },
		createdAt: { type: Date, default: Date.now },
	},
	{ collection: "notification_secrets" }
);

export const preferenceSchema = new Schema<NotificationPreference>(
	{
		userId: { type: String, required: true, index: true },
		topic: { type: String, required: true },
		inApp: { type: Boolean, default: true },
		email: { type: Boolean, default: false },
		push: { type: Boolean, default: false },
		updatedAt: { type: Date, default: Date.now },
	},
	{ collection: "notification_preferences" }
);

// Una fila de preferencia por (usuario, topic).
preferenceSchema.index({ userId: 1, topic: 1 }, { unique: true });
