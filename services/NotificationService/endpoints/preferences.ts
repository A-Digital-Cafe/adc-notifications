import { Type } from "@sinclair/typebox";
import { RegisterEndpoint, UncommonResponse, type EndpointCtx } from "@services/core/EndpointManagerService/index.js";
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

	/**
	 * Baja en un clic desde el cliente de correo (RFC 8058). Lo invoca el cliente, no la persona:
	 * llega sin sesión ni cookies y la autorización es el token firmado, de ahí el `skipCsrf`.
	 *
	 * Un token inválido o vencido responde 200 igual: distinguirlo haría del endpoint un oráculo
	 * para probar tokens, y el cliente de correo no tiene cómo mostrar el error a nadie.
	 */
	@RegisterEndpoint({
		method: "POST",
		url: "/api/notifications/unsubscribe",
		options: {
			tag: "NotificationService/Preferences",
			summary: "Baja en un clic de los avisos por email de un topic (RFC 8058)",
			description: "Autoriza el token firmado del enlace, no la sesión. Lo llama el cliente de correo.",
			skipCsrf: true,
			skipIdempotency: true,
			rateLimit: { max: 30, timeWindow: 60_000 },
			schema: { querystring: PS.UnsubscribeQuery, response: { 200: PS.UnsubscribeResponse } },
		},
	})
	static async unsubscribe(ctx: EndpointCtx) {
		const topic = ctx.query.token ? await PreferenceEndpoints.service.applyUnsubscribeToken(ctx.query.token) : null;
		return { unsubscribed: topic !== null, topic };
	}

	/**
	 * El mismo enlace abierto en un navegador. **No da de baja**, redirige a preferencias: los
	 * escáneres de correo y los prefetch hacen GET a todo lo que ven, y una baja disparada por un
	 * antivirus sería una preferencia que nadie pidió. La baja efectiva es el POST de arriba.
	 */
	@RegisterEndpoint({
		method: "GET",
		url: "/api/notifications/unsubscribe",
		options: {
			tag: "NotificationService/Preferences",
			summary: "Redirige a las preferencias de notificación (no da de baja)",
			schema: { querystring: PS.UnsubscribeQuery, response: { 302: Type.Null({ description: "Redirección a preferencias" }) } },
		},
	})
	static unsubscribePage(): never {
		// `UncommonResponse` se lanza, no se devuelve: el envío especial lo hace el manejador de errores.
		throw UncommonResponse.redirect(PreferenceEndpoints.service.preferencesUrl, { status: 302 });
	}
}
