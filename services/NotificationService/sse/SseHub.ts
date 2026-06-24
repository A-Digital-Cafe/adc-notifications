import { randomUUID } from "node:crypto";
import type { ILogger } from "@interfaces/utils/ILogger.d.ts";
import type { NotificationStreamEvent } from "@common/types/notifications/Notification.ts";

/**
 * Conexión SSE viva de un cliente. La capa de transporte (ruta Fastify) provee
 * `send`/`close` sobre el socket crudo; el hub no conoce Fastify.
 */
export interface SseConnection {
	/** Escribe una línea/bloque ya formateado en el stream. */
	send: (chunk: string) => void;
	/** Cierra el stream. */
	close: () => void;
}

interface SseClient {
	id: string;
	userId: string;
	conn: SseConnection;
}

const HEARTBEAT_MS = 25_000;

/**
 * Registro en memoria de conexiones SSE por usuario y emisor de eventos.
 *
 * MVP single-instance: cada instancia mantiene sus propias conexiones. Para
 * multi-instancia, un fan-out por cola (RabbitMQ) debería reemitir el evento a la
 * instancia que sostiene la conexión del usuario (extensión futura).
 */
export class SseHub {
	readonly #byUser = new Map<string, Set<SseClient>>();
	readonly #logger: ILogger;
	#heartbeat: NodeJS.Timeout | null = null;

	constructor(logger: ILogger) {
		this.#logger = logger;
		this.#heartbeat = setInterval(() => this.#ping(), HEARTBEAT_MS);
		this.#heartbeat.unref?.();
	}

	/** Registra una conexión y devuelve el disposer para quitarla al cerrarse. */
	add(userId: string, conn: SseConnection): () => void {
		const client: SseClient = { id: randomUUID(), userId, conn };
		let set = this.#byUser.get(userId);
		if (!set) {
			set = new Set();
			this.#byUser.set(userId, set);
		}
		set.add(client);
		this.#logger.logDebug(`SSE: cliente conectado (${userId}); total usuario=${set.size}`);
		return () => this.#remove(client);
	}

	#remove(client: SseClient): void {
		const set = this.#byUser.get(client.userId);
		if (!set) return;
		set.delete(client);
		if (set.size === 0) this.#byUser.delete(client.userId);
	}

	/** Emite un evento a todas las conexiones vivas de un usuario. */
	publishToUser(userId: string, event: NotificationStreamEvent): void {
		const set = this.#byUser.get(userId);
		if (!set || set.size === 0) return;
		const chunk = `data: ${JSON.stringify(event)}\n\n`;
		for (const client of set) {
			try {
				client.conn.send(chunk);
			} catch (e) {
				this.#logger.logWarn(`SSE: error escribiendo a ${userId}: ${(e as Error).message}`);
				this.#remove(client);
			}
		}
	}

	#ping(): void {
		for (const set of this.#byUser.values()) {
			for (const client of set) {
				try {
					client.conn.send(": ping\n\n");
				} catch {
					this.#remove(client);
				}
			}
		}
	}

	/** Cierra todas las conexiones y detiene el heartbeat (al parar el servicio). */
	stop(): void {
		if (this.#heartbeat) clearInterval(this.#heartbeat);
		this.#heartbeat = null;
		for (const set of this.#byUser.values()) {
			for (const client of set) {
				try {
					client.conn.close();
				} catch {
					/* noop */
				}
			}
		}
		this.#byUser.clear();
	}
}
