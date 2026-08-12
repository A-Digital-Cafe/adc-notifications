import { randomUUID } from "node:crypto";
import type { ILogger } from "@interfaces/utils/ILogger.d.ts";
import type { NotificationStreamEvent } from "@common/types/notifications/Notification.ts";
import { SseHeartbeat, SSE_PING, sseEvent, type SseConnection } from "@common/utils/sse.ts";
import type { ConnectionAffinity } from "@common/utils/connection-affinity.ts";

export type { SseConnection };

interface SseClient {
	id: string;
	userId: string;
	conn: SseConnection;
}

/**
 * Máximo de conexiones SSE simultáneas por usuario. La ruta secuestra el socket y no
 * pasa por el rate-limiter, así que sin este tope una sola cuenta podía abrir conexiones
 * sin límite hasta agotar los descriptores/memoria del servidor (DoS). Ver ADC-01.
 */
const MAX_CONNECTIONS_PER_USER = 10;

/**
 * Vencimiento de la afinidad, holgado frente al latido de 25 s que la renueva: perder dos latidos
 * o un hipo de Redis no debe hacer parecer que el usuario se fue a otro nodo. Lo consume el
 * servicio, que es quien arma el puerto contra `ClusterService`.
 */
export const SSE_AFFINITY_TTL_SECONDS = 90;

/** Clave de afinidad de las conexiones de un usuario (el mismo formato que resuelve `whereIs`). */
const affinityKey = (userId: string): string => `sse:user:${userId}`;

/**
 * Registro en memoria de conexiones SSE por usuario y emisor de eventos. El transporte
 * (hijack, headers, heartbeat) vive en `@common/utils/sse`; acá queda sólo el índice por
 * usuario, que es lo propio de este servicio.
 *
 * **Este índice es por proceso y así se queda**: un hub sólo puede entregar a los sockets que
 * sostiene. El fan-out entre nodos NO vive acá sino en `NotificationService.#emitToUser`, que
 * entrega local y además emite por el bus del clúster para que cada nodo ofrezca el evento a sus
 * propias conexiones. Mezclar las dos cosas obligaría a este hub a saber de brokers.
 *
 * Lo que sí publica es **dónde** está cada usuario (`sse:user:<id>`). Con el fan-out no hace falta
 * para entregar; sirve para diagnosticar ("¿en qué nodo está conectado?") y deja lista la afinidad
 * si algún día algo tiene que ir al nodo exacto. El endpoint SSE no se desvía por eso: ver el
 * arranque del servicio.
 */
export class SseHub {
	readonly #byUser = new Map<string, Set<SseClient>>();
	readonly #logger: ILogger;
	/** `null` sin clúster: el hub se comporta igual. */
	readonly #affinity: ConnectionAffinity | null;
	#heartbeat: SseHeartbeat | null;

	constructor(logger: ILogger, affinity: ConnectionAffinity | null = null) {
		this.#logger = logger;
		this.#affinity = affinity;
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
		// Tope por usuario: al superarlo se cierra la conexión más antigua (el Set conserva
		// orden de inserción). Una pestaña nueva legítima sigue funcionando; un abuso no
		// acumula conexiones. Ver ADC-01.
		while (set.size >= MAX_CONNECTIONS_PER_USER) {
			const oldest = set.values().next().value as SseClient | undefined;
			if (!oldest) break;
			this.#remove(oldest);
			try {
				oldest.conn.close();
			} catch {
				/* noop: cerrar dispara el onClose, que ya invoca el disposer de esa conexión */
			}
		}
		set.add(client);
		// `claim` pisa al dueño anterior, así que una pestaña nueva contra otro nodo se lleva la
		// afinidad: el puntero describe dónde está el usuario ahora, no dónde estuvo primero.
		this.#affinity?.claim(affinityKey(userId));
		this.#logger.logDebug(`SSE: cliente conectado (${userId}); total usuario=${set.size}`);
		return () => this.#remove(client);
	}

	#remove(client: SseClient): void {
		const set = this.#byUser.get(client.userId);
		if (!set) return;
		set.delete(client);
		if (set.size === 0) {
			this.#byUser.delete(client.userId);
			// Recién con la última conexión del usuario en este nodo; cerrar una pestaña de varias
			// no lo mueve de lugar. Si mientras tanto se reconectó a otro nodo, `release` no toca
			// nada: sólo borra lo que sigue siendo de éste.
			this.#affinity?.release(affinityKey(client.userId));
		}
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
		for (const [userId, set] of this.#byUser) {
			for (const client of set) {
				try {
					client.conn.send(SSE_PING);
				} catch {
					this.#remove(client);
				}
			}
			// El latido es también el que renueva la afinidad, así que no hay un segundo timer que
			// se pueda desincronizar. Sólo si quedó alguna conexión viva: si todas murieron en este
			// mismo barrido, `#remove` ya soltó y renovar resucitaría un puntero a un nodo vacío.
			if (set.size > 0) this.#affinity?.claim(affinityKey(userId));
		}
	}

	/** Cierra todas las conexiones y detiene el heartbeat (al parar el servicio). */
	stop(): void {
		this.#heartbeat?.stop();
		this.#heartbeat = null;
		for (const [userId, set] of this.#byUser) {
			// Soltar acá y no confiar en el disposer de cada conexión: el `close` dispara su
			// `onClose` recién en el próximo tick, con el índice ya vacío.
			this.#affinity?.release(affinityKey(userId));
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
