import type { NotificationChannel } from "@common/types/notifications/Notification.ts";

/**
 * Plantilla server-side de un **topic reservado**. El contenido (title/body/link)
 * lo define el servidor, NO el productor: así un módulo no confiable no puede
 * inyectar texto de phishing bajo un topic creíble (p.ej. "tu contraseña cambió,
 * contactá a soporte@evil.com"). A lo sumo dispara el aviso canónico de la plataforma.
 */
export interface SystemTopicTemplate {
	title: string;
	body: string;
	channels?: NotificationChannel[];
	linkApp?: string;
	link?: string;
	/** Módulos productores autorizados a disparar este topic (allowlist + auditoría). */
	allowedOrigins: readonly string[];
}

/**
 * Topics de sistema: namespaces cuyo contenido se renderiza desde el servidor y cuyo
 * origen se valida. Hoy `security.*`. Extender acá para nuevos topics sensibles.
 */
export const SYSTEM_TOPIC_TEMPLATES: Readonly<Record<string, SystemTopicTemplate>> = {
	"security.password_changed": {
		title: "Tu contraseña fue cambiada",
		body: "Si no fuiste vos, contactá a soporte de inmediato.",
		channels: ["inApp", "email"],
		linkApp: "my-account",
		link: "/settings/privacy-security",
		allowedOrigins: ["IdentityManagerService"],
	},
};

/** Prefijos reservados: todo topic bajo estos namespaces DEBE tener plantilla declarada. */
export const RESERVED_TOPIC_PREFIXES = ["security."] as const;

export function isReservedTopic(topic: string): boolean {
	return RESERVED_TOPIC_PREFIXES.some((p) => topic.startsWith(p));
}

interface RateWindow {
	count: number;
	resetAt: number;
}

/**
 * Rate limiter de ventana fija en memoria. Es la defensa **con teeth** contra el
 * flood/spam de notificaciones: vive en el único choke point de entrega, así que
 * aplica sin importar el origen (forjable o no). Acotado en memoria por poda perezosa.
 */
export class RateLimiter {
	readonly #buckets = new Map<string, RateWindow>();
	readonly #max: number;
	readonly #windowMs: number;
	static readonly #PRUNE_THRESHOLD = 10_000;

	constructor(max: number, windowMs: number) {
		this.#max = max;
		this.#windowMs = windowMs;
	}

	/** `true` si la operación entra en cuota; `false` si la excede (debe descartarse). */
	allow(key: string, now: number = Date.now()): boolean {
		let w = this.#buckets.get(key);
		if (!w || now >= w.resetAt) {
			if (this.#buckets.size > RateLimiter.#PRUNE_THRESHOLD) this.#prune(now);
			w = { count: 0, resetAt: now + this.#windowMs };
			this.#buckets.set(key, w);
		}
		if (w.count >= this.#max) return false;
		w.count++;
		return true;
	}

	#prune(now: number): void {
		for (const [k, v] of this.#buckets) if (now >= v.resetAt) this.#buckets.delete(k);
	}
}
