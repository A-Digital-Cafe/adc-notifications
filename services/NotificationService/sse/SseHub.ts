import { randomUUID } from "node:crypto";
import type { ILogger } from "@interfaces/utils/ILogger.d.ts";
import type { NotificationStreamEvent } from "@common/types/notifications/Notification.ts";
import { SseHeartbeat, SSE_PING, sseEvent, type SseConnection } from "@common/utils/sse.ts";

export type { SseConnection };

interface SseClient {
	id: string;
	userId: string;
	conn: SseConnection;
}

/**
 * Registro en memoria de conexiones SSE por usuario y emisor de eventos. El transporte
 * (hijack, headers, heartbeat) vive en `@common/utils/sse`; acá queda sólo el índice por
 * usuario, que es lo propio de este servicio.
 *
 * MVP single-instance: cada instancia mantiene sus propias conexiones. Para
 * multi-instancia, un fan-out por cola (RabbitMQ) debería reemitir el evento a la
 * instancia que sostiene la conexión del usuario (extensión futura).
 */
export class SseHub {
	readonly #byUser = new Map<string, Set<SseClient>>();
	readonly #logger: ILogger;
	#heartbeat: SseHeartbeat | null;

	constructor(logger: ILogger) {
		this.#logger = logger;
		this.#heartbeat = new SseHeartbeat(() => this.#ping());
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
		const chunk = sseEvent(event);
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
					client.conn.send(SSE_PING);
				} catch {
					this.#remove(client);
				}
			}
		}
	}

	/** Cierra todas las conexiones y detiene el heartbeat (al parar el servicio). */
	stop(): void {
		this.#heartbeat?.stop();
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
