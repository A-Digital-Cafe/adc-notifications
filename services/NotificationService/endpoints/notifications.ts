import { Type } from "@sinclair/typebox";
import { RegisterEndpoint, type EndpointCtx } from "@services/core/EndpointManagerService/index.js";
import { NotificationError } from "@common/types/custom-errors/NotificationError.ts";
import type NotificationService from "../index.ts";
import * as NS from "./schemas/notifications.ts";

function requireUserId(ctx: EndpointCtx): string {
	const userId = ctx.user?.id;
	if (!userId) throw new NotificationError(401, "UNAUTHENTICATED", "Autenticación requerida");
	return userId;
}

export class NotificationEndpoints {
	private static service: NotificationService;
	private static kernelKey: symbol;

	static init(service: NotificationService, kernelKey: symbol): void {
		NotificationEndpoints.service ??= service;
		NotificationEndpoints.kernelKey ??= kernelKey;
	}

	@RegisterEndpoint({
		method: "GET",
		url: "/api/notifications",
		requireAuth: true,
		options: {
			tag: "NotificationService/Inbox",
			summary: "Lista la bandeja del usuario (paginada por cursor)",
			schema: {
				querystring: NS.ListQuery,
				response: { 200: NS.ListResponse, 204: Type.Null({ description: "Bandeja vacía o fin del cursor" }) },
			},
		},
	})
	static async list(ctx: EndpointCtx) {
		const svc = NotificationEndpoints.service;
		const userId = requireUserId(ctx);
		const limit = ctx.query.limit ? Number(ctx.query.limit) : undefined;
		const before = ctx.query.before ? new Date(ctx.query.before) : undefined;
		const [notifications, unread] = await Promise.all([
			svc.notifications.list(userId, { limit, before: before && !Number.isNaN(before.getTime()) ? before : undefined }),
			svc.notifications.unreadCount(userId),
		]);
		// Con cursor `before`, una página vacía sólo significa "no hay más": el front
		// conserva el conteo que ya tenía en vez de asumir bandeja vacía.
		if (notifications.length === 0) return undefined;
		return { notifications, unread };
	}

	@RegisterEndpoint({
		method: "GET",
		url: "/api/notifications/unread-count",
		requireAuth: true,
		options: {
			tag: "NotificationService/Inbox",
			summary: "Conteo de notificaciones no leídas",
			etag: true,
			schema: { response: { 200: NS.UnreadCountResponse, 204: Type.Null({ description: "Nada sin leer" }) } },
		},
	})
	static async unreadCount(ctx: EndpointCtx) {
		const svc = NotificationEndpoints.service;
		const userId = requireUserId(ctx);
		const unread = await svc.notifications.unreadCount(userId);
		return unread === 0 ? undefined : { unread };
	}

	@RegisterEndpoint({
		method: "POST",
		url: "/api/notifications/:id/read",
		requireAuth: true,
		options: {
			tag: "NotificationService/Inbox",
			summary: "Marca una notificación como leída",
			// Idempotente por naturaleza (fija readAt): sin guard de Idempotency-Key.
			skipIdempotency: true,
			schema: {
				params: NS.NotificationIdParams,
				response: { 200: NS.ReadResponse, 204: Type.Null({ description: "Ya no estaba en la bandeja (no-op)" }) },
			},
		},
	})
	static async markRead(ctx: EndpointCtx<{ id: string }>) {
		const svc = NotificationEndpoints.service;
		const userId = requireUserId(ctx);
		const unread = await svc.markRead(userId, ctx.params.id);
		return unread === null ? undefined : { ok: true, unread };
	}

	@RegisterEndpoint({
		method: "DELETE",
		url: "/api/notifications/:id",
		requireAuth: true,
		options: {
			tag: "NotificationService/Inbox",
			summary: "Elimina una notificación de la bandeja del usuario",
			// Idempotente por naturaleza (borrar dos veces = 204 inocuo): sin guard de Idempotency-Key.
			skipIdempotency: true,
			schema: {
				params: NS.NotificationIdParams,
				response: { 200: NS.ReadResponse, 204: Type.Null({ description: "Ya no estaba en la bandeja (no-op)" }) },
			},
		},
	})
	static async remove(ctx: EndpointCtx<{ id: string }>) {
		const svc = NotificationEndpoints.service;
		const userId = requireUserId(ctx);
		const unread = await svc.deleteNotification(userId, ctx.params.id);
		return unread === null ? undefined : { ok: true, unread };
	}

	@RegisterEndpoint({
		method: "POST",
		url: "/api/notifications/read-all",
		requireAuth: true,
		options: {
			tag: "NotificationService/Inbox",
			summary: "Marca todas las notificaciones como leídas",
			// Idempotente por naturaleza (fija readAt en masa): sin guard de Idempotency-Key.
			skipIdempotency: true,
			schema: { response: { 200: NS.ReadResponse, 204: Type.Null({ description: "Nada sin leer" }) } },
		},
	})
	static async markAllRead(ctx: EndpointCtx) {
		const svc = NotificationEndpoints.service;
		const userId = requireUserId(ctx);
		const changed = await svc.markAllRead(userId);
		return changed === 0 ? undefined : { ok: true, unread: 0 };
	}
}
