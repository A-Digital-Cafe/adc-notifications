import type { IHostBasedHttpProvider, FastifyRequest, FastifyReply } from "@interfaces/modules/providers/IHttpServer.d.ts";
import type { ISessionVerifier } from "@common/types/identity/SessionVerifier.ts";
import type { ILogger } from "@interfaces/utils/ILogger.d.ts";
import { createCorsOriginGuard } from "@providers/http/fastify-server/security/index.js";
import type { SseHub, SseConnection } from "./SseHub.ts";

export interface SseRouteDeps {
	httpProvider: IHostBasedHttpProvider;
	hub: SseHub;
	/** Verificador de sesión (lazy): la campana manda la cookie de sesión. */
	getVerifier: () => ISessionVerifier | null;
	/** Conteo inicial de no leídas para el evento `ready`. */
	getUnreadCount: (userId: string) => Promise<number>;
	logger: ILogger;
}

const SSE_PATH = "/api/notifications/stream";

/**
 * Registra el endpoint SSE long-lived sobre el socket crudo. No usa el flujo
 * normal de `@RegisterEndpoint` (que bufferiza la respuesta): hace `reply.hijack()`
 * y escribe en `reply.raw`, evitando el gotcha de Bun con `reply.send(Readable)`.
 */
export function registerSseRoute(deps: SseRouteDeps): void {
	const { httpProvider, hub, getVerifier, getUnreadCount, logger } = deps;

	// El stream se sirve sobre el socket crudo (hijack), saltándose el hook de
	// `@fastify/cors`; replicamos la MISMA política de orígenes del provider para
	// que un EventSource cross-origin (apps en otros puertos en dev) reciba CORS.
	const isDev = process.env.NODE_ENV !== "production";
	const corsGuard = createCorsOriginGuard(isDev, () => httpProvider.getRegisteredHosts());
	const corsHeadersFor = (origin: string | undefined): Record<string, string> => {
		if (!origin) return {};
		let allow = false;
		corsGuard(origin, (_e, ok) => {
			allow = !!ok;
		});
		if (!allow) return {};
		return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" };
	};

	httpProvider.registerRoute("GET", SSE_PATH, async (req: FastifyRequest, reply: FastifyReply) => {
		const rep = reply as unknown as { hijack?: () => void; raw: NodeResponse; code: (n: number) => { send: (b: unknown) => void } };
		const request = req as unknown as { raw: NodeRequest; cookies?: Record<string, string>; headers?: Record<string, string | undefined> };

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
		const raw = rep.raw;
		raw.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			// Desactiva el buffering de proxies (nginx) para el stream.
			"X-Accel-Buffering": "no",
			...corsHeadersFor(request.headers?.origin),
		});
		raw.write(":\n\n"); // abre el stream

		const conn: SseConnection = {
			send: (chunk: string) => raw.write(chunk),
			close: () => {
				try {
					raw.end();
				} catch {
					/* noop */
				}
			},
		};
		const dispose = hub.add(userId, conn);

		// 3. Evento inicial con el conteo actual de no leídas.
		try {
			const unread = await getUnreadCount(userId);
			raw.write(`data: ${JSON.stringify({ type: "ready", unread })}\n\n`);
		} catch (e) {
			logger.logWarn(`SSE: no se pudo enviar conteo inicial a ${userId}: ${(e as Error).message}`);
		}

		// 4. Limpieza al cerrarse el cliente.
		const cleanup = () => {
			dispose();
			conn.close();
		};
		request.raw.on("close", cleanup);
		request.raw.on("error", cleanup);
	});

	logger.logDebug(`SSE: endpoint registrado en ${SSE_PATH}`);
}

/** Tipos mínimos del socket crudo de Node (evita depender de los tipos de Fastify). */
interface NodeResponse {
	writeHead: (status: number, headers: Record<string, string>) => void;
	write: (chunk: string) => boolean;
	end: () => void;
}
interface NodeRequest {
	on: (event: string, listener: () => void) => void;
}
