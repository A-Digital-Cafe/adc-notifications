import type { IHostBasedHttpProvider, FastifyRequest, FastifyReply } from "@interfaces/modules/providers/IHttpServer.d.ts";
import type { ISessionVerifier } from "@common/types/identity/SessionVerifier.ts";
import type { ILogger } from "@interfaces/utils/ILogger.d.ts";
import { isPlatformOrigin } from "@providers/http/fastify-server/security/index.js";
import { openSseStream, sseEvent, type RawRequestSource } from "@common/utils/sse.ts";
import type { RawResponseSink } from "@common/utils/http-stream.ts";
import type { SseHub } from "./SseHub.ts";

export interface SseRouteDeps {
	httpProvider: IHostBasedHttpProvider;
	hub: SseHub;
	/** Verificador de sesión (lazy): la campana manda la cookie de sesión. */
	getVerifier: () => ISessionVerifier | null;
	/** Conteo inicial de no leídas para el evento `ready`. */
	getUnreadCount: (userId: string) => Promise<number>;
	logger: ILogger;
	/** Nombre del módulo dueño: sin él la ruta sobrevive a la detención del servicio. */
	owner: string;
}

const SSE_PATH = "/api/notifications/stream";

/**
 * Registra el endpoint SSE long-lived sobre el socket crudo. No usa el flujo
 * normal de `@RegisterEndpoint` (que bufferiza la respuesta): hace `reply.hijack()`
 * y escribe en `reply.raw`, evitando el gotcha de Bun con `reply.send(Readable)`.
 */
export function registerSseRoute(deps: SseRouteDeps): void {
	const { httpProvider, hub, getVerifier, getUnreadCount, logger, owner } = deps;

	// El stream se sirve sobre el socket crudo (hijack), saltándose el hook de
	// `@fastify/cors`; replicamos la MISMA política de orígenes del provider para
	// que un EventSource cross-origin (apps en otros puertos en dev) reciba CORS.
	const corsHeadersFor = (origin: string | undefined): Record<string, string> => {
		if (!isPlatformOrigin(origin, httpProvider.getRegisteredHosts())) return {};
		return { "Access-Control-Allow-Origin": origin!, "Access-Control-Allow-Credentials": "true", Vary: "Origin" };
	};

	httpProvider.registerRoute("GET", SSE_PATH, async (req: FastifyRequest, reply: FastifyReply) => {
		const rep = reply as unknown as { hijack?: () => void; raw: RawResponseSink; code: (n: number) => { send: (b: unknown) => void } };
		const request = req as unknown as { raw: RawRequestSource; cookies?: Record<string, string>; headers?: Record<string, string | undefined> };

		// 1. Autenticación: token de sesión desde la cookie del request.
		const verifier = getVerifier();
		if (!verifier) {
			rep.code(503).send({ error: "SSE_UNAVAILABLE", message: "Verificador de sesión no disponible" });
			return;
		}
		const token = verifier.extractSessionToken(request);
		const result = token ? await verifier.verifyToken(token) : { valid: false };
		const userId = result.valid ? result.session?.user?.id : undefined;
		if (!userId) {
			rep.code(401).send({ error: "UNAUTHENTICATED", message: "Sesión inválida" });
			return;
		}

		// 2. Hijack: tomamos control del socket; Fastify no enviará respuesta.
		if (typeof rep.hijack !== "function") {
			rep.code(500).send({ error: "SSE_UNSUPPORTED", message: "El servidor no soporta hijack" });
			return;
		}
		rep.hijack();

		// `dispose` se resuelve tarde: `openSseStream` engancha la limpieza antes de que el
		// hub devuelva su disposer, y un cliente que corta en ese hueco no debe reventar.
		let dispose: (() => void) | null = null;
		const conn = openSseStream(rep.raw, request.raw, {
			headers: corsHeadersFor(request.headers?.origin),
			onClose: () => dispose?.(),
		});
		dispose = hub.add(userId, conn);

		// 3. Evento inicial con el conteo actual de no leídas.
		try {
			const unread = await getUnreadCount(userId);
			conn.send(sseEvent({ type: "ready", unread }));
		} catch (e) {
			logger.logWarn(`SSE: no se pudo enviar conteo inicial a ${userId}: ${(e as Error).message}`);
		}
	}, owner);

	logger.logDebug(`SSE: endpoint registrado en ${SSE_PATH}`);
}
