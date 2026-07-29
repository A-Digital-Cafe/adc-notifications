import { Type } from "@sinclair/typebox";
import { RegisterEndpoint, type EndpointCtx } from "@services/core/EndpointManagerService/index.js";
import { NotificationError } from "@common/types/custom-errors/NotificationError.ts";
import type { NotificationChannel, NotificationTopic } from "@common/types/notifications/Notification.ts";
import type NotificationService from "../index.ts";
import * as PS from "./schemas/preferences.ts";

function requireUserId(ctx: EndpointCtx): string {
	const userId = ctx.user?.id;
	if (!userId) throw new NotificationError(401, "UNAUTHENTICATED", "Autenticación requerida");
	return userId;
}

export class PreferenceEndpoints {
	private static service: NotificationService;
	private static kernelKey: symbol;

	static init(service: NotificationService, kernelKey: symbol): void {
		PreferenceEndpoints.service ??= service;
		PreferenceEndpoints.kernelKey ??= kernelKey;
	}

	@RegisterEndpoint({
		method: "GET",
		url: "/api/notifications/preferences",
		requireAuth: true,
		options: {
			tag: "NotificationService/Preferences",
			summary: "Lista las preferencias de canal del usuario",
			schema: {
				response: { 200: PS.PreferencesListResponse, 204: Type.Null({ description: "Sin preferencias fijadas: rigen los defaults" }) },
			},
		},
	})
	static async list(ctx: EndpointCtx) {
		const svc = PreferenceEndpoints.service;
		const userId = requireUserId(ctx);
		const preferences = await svc.preferences.list(userId);
		return preferences.length === 0 ? undefined : { preferences };
	}

	@RegisterEndpoint({
		method: "PUT",
		url: "/api/notifications/preferences/:topic",
		requireAuth: true,
		options: {
			tag: "NotificationService/Preferences",
			summary: "Fija las preferencias de canal de un topic",
			schema: { params: PS.TopicParams, body: PS.SetPreferenceBody, response: { 200: PS.SetPreferenceResponse } },
		},
	})
	static async set(ctx: EndpointCtx<{ topic: NotificationTopic }, Partial<Record<NotificationChannel, boolean>>>) {
		const svc = PreferenceEndpoints.service;
		const userId = requireUserId(ctx);
		const topic: NotificationTopic = ctx.params.topic;
		if (!topic) throw new NotificationError(400, "MISSING_FIELDS", "topic requerido");
		return svc.preferences.set(userId, topic, ctx.data ?? {});
	}
}
