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
	// El aviso sale al MOMENTO del pedido, cuando la casilla registrada todavía es la
	// vieja: es la ventana de reacción ante un pedido hostil con sesión robada. La
	// casilla nueva enmascarada viaja en `data` (nunca en el texto: anti-phishing).
	"security.email_change_requested": {
		title: "Pediste cambiar el email de tu cuenta",
		body: "Enviamos un enlace de confirmación a la casilla nueva. Si no fuiste vos, cambiá tu contraseña y contactá a soporte de inmediato.",
		channels: ["inApp", "email"],
		linkApp: "my-account",
		link: "/settings/privacy-security",
		allowedOrigins: ["IdentityManagerService"],
	},
	"security.email_changed": {
		title: "El email de tu cuenta fue cambiado",
		body: "Si no fuiste vos, contactá a soporte de inmediato.",
		channels: ["inApp", "email"],
		linkApp: "my-account",
		link: "/settings/privacy-security",
		allowedOrigins: ["IdentityManagerService"],
	},
	"security.username_changed": {
		title: "Tu nombre de usuario fue cambiado",
		body: "Si no fuiste vos, contactá a soporte de inmediato.",
		channels: ["inApp", "email"],
		linkApp: "my-account",
		link: "/settings/privacy-security",
		allowedOrigins: ["IdentityManagerService"],
	},
	"security.two_factor_enabled": {
		title: "Activaste la verificación en dos pasos",
		body: "Guardá tus códigos de recuperación en un lugar seguro: son la única forma de entrar si perdés el autenticador.",
		channels: ["inApp", "email"],
		linkApp: "my-account",
		link: "/settings/privacy-security",
		allowedOrigins: ["IdentityManagerService"],
	},
	"security.two_factor_disabled": {
		title: "Desactivaste la verificación en dos pasos",
		body: "Tu cuenta vuelve a entrar sólo con contraseña. Si no fuiste vos, cambiala y contactá a soporte de inmediato.",
		channels: ["inApp", "email"],
		linkApp: "my-account",
		link: "/settings/privacy-security",
		allowedOrigins: ["IdentityManagerService"],
	},
	// Topic aparte del anterior: el texto lo fija esta plantilla, así que es la única forma de que
	// el aviso diga que la baja NO la pidió el titular.
	"security.two_factor_reset": {
		title: "Un administrador reseteó tu verificación en dos pasos",
		body: "Tu cuenta vuelve a entrar sólo con contraseña. Si no lo pediste, cambiá tu contraseña y contactá a soporte de inmediato.",
		channels: ["inApp", "email"],
		linkApp: "my-account",
		link: "/settings/privacy-security",
		allowedOrigins: ["IdentityManagerService"],
	},
	"security.new_login": {
		title: "Nuevo inicio de sesión",
		body: "Se detectó un inicio de sesión desde una IP nueva. Si no fuiste vos, cambiá tu contraseña.",
		channels: ["inApp", "email"],
		linkApp: "my-account",
		link: "/settings/privacy-security",
		allowedOrigins: ["SessionManagerService"],
	},
	"security.sessions_revoked": {
		title: "Tus sesiones fueron cerradas",
		body: "Un administrador cerró tus sesiones activas. Vas a tener que iniciar sesión de nuevo.",
		channels: ["inApp", "email"],
		linkApp: "my-account",
		link: "/settings/privacy-security",
		allowedOrigins: ["SessionManagerService"],
	},
	// Alerta interna para el equipo (Admins + Security Managers globales): ban
	// aplicado/levantado, rol modificado/eliminado, usuario eliminado. El detalle
	// viaja en `data`; el texto visible es canónico (anti-phishing).
	"security.alert": {
		title: "Alerta de seguridad",
		body: "Se registró una acción administrativa sensible (moderación, roles o usuarios). Revisá el panel de identidad.",
		linkApp: "identity",
		link: "/users",
		allowedOrigins: ["IdentityManagerService"],
	},
	// Alerta interna para el equipo (mismos destinatarios): un módulo agotó sus
	// reintentos rápidos y quedó en reintento lento (circuit breaker del kernel
	// abierto). El módulo y el último error viajan en `data`.
	"security.module_failure": {
		title: "Fallo de módulo en la plataforma",
		body: "Un módulo está fallando repetidamente y pasó a reintentos lentos. Revisá el gestor de módulos.",
		linkApp: "modules",
		link: "/",
		allowedOrigins: ["IdentityManagerService"],
	},
	// Alerta interna para el equipo (mismos destinatarios): apareció un módulo NUEVO
	// en runtime. NO se ejecutó (queda pendiente de lanzamiento manual); el aviso pide
	// revisarlo en el gestor de módulos. El detalle (módulo, capa, path) viaja en `data`.
	"security.module_detected": {
		title: "Módulo nuevo detectado en la plataforma",
		body: "Se detectó un módulo nuevo en runtime. No se ejecutó: está pendiente de lanzamiento en el gestor de módulos.",
		linkApp: "modules",
		link: "/",
		allowedOrigins: ["IdentityManagerService"],
	},
	// Alerta interna para el equipo (mismos destinatarios): un módulo pidió privilegios
	// (`config.json` → `privileges`) que no tenía en su provisión anterior. El caso típico es
	// un `git pull` que trae un config ampliado. Los scopes agregados y los retenidos por
	// falta de aprobación viajan en `data`.
	"security.module_privileges": {
		title: "Cambio de privilegios de un módulo",
		body: "Un módulo pidió privilegios que antes no tenía. Revisalo en el gestor de módulos.",
		linkApp: "modules",
		link: "/",
		allowedOrigins: ["IdentityManagerService"],
	},
	// Alerta interna para el equipo (mismos destinatarios): un chequeo de integridad de la
	// infraestructura pasó a fallar. Es el aviso que ningún healthcheck da — un almacenamiento con
	// una copia faltante o un Redis que no puede volcar a disco responden verde desde afuera —, así
	// que el texto empuja a mirar el informe y no a suponer que ya se está reintentando solo. Sale
	// UNA vez, en el flanco: el detalle (chequeo, nodo, motivo) viaja en `data`.
	"security.integrity_failed": {
		title: "Fallo de integridad en la infraestructura",
		body: "Un chequeo de integridad de la infraestructura pasó a fallar. Revisá el informe en el panel de red: no se repara solo.",
		linkApp: "network",
		link: "/",
		allowedOrigins: ["IdentityManagerService"],
	},
	// Alerta interna para el equipo (mismos destinatarios): se desplegó una versión nueva de los
	// Términos o de la Política de Privacidad. Los Términos obligan a anunciar con antelación los
	// cambios que reducen beneficios, y la constancia de aceptación queda ligada a la versión: sin
	// este aviso el cambio entra en vigor y nadie se acuerda de comunicarlo. Las versiones viajan
	// en `data`.
	"security.legal_docs_updated": {
		title: "Cambió un documento legal de la plataforma",
		body: "Se publicó una versión nueva de los Términos o de la Política de Privacidad. Falta anunciarla a las personas usuarias.",
		linkApp: "modules",
		link: "/",
		allowedOrigins: ["IdentityManagerService"],
	},
};

/** Prefijos reservados: todo topic bajo estos namespaces DEBE tener plantilla declarada. */
export const RESERVED_TOPIC_PREFIXES = ["security."] as const;

// Broadcasts: sin allowlist de `origin` (forjable); la puerta es la capability con
// scope `notifications:broadcast` + firma HMAC de los jobs (ver index.ts).

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
