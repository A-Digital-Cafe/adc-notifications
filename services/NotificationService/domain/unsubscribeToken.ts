import crypto from "node:crypto";

/**
 * Token de baja para `List-Unsubscribe` (RFC 8058). El cliente de correo hace el POST **sin sesión
 * ni cookies**, así que el token es la única prueba de que quien pide la baja es el destinatario:
 * va firmado con HMAC y acotado a `(usuario, topic)`, y no autentica nada más que apagar ese canal.
 *
 * Vence porque el enlace queda en la casilla para siempre y un buzón comprometido dos años después
 * no debería tocar preferencias. Un token vencido no es error del usuario: se lo manda a la página.
 */

/** Ventana de validez del enlace. Larga a propósito: la baja tiene que seguir andando meses después. */
const TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

const VERSION = "u1";

export interface UnsubscribePayload {
	userId: string;
	topic: string;
}

function sign(data: string, key: Buffer): string {
	return crypto.createHmac("sha256", key).update(data).digest("base64url");
}

/** `u1.<payload b64url>.<hmac b64url>`. Seguro en URL sin escapar. */
export function createUnsubscribeToken(payload: UnsubscribePayload, key: Buffer, now: number = Date.now()): string {
	const body = Buffer.from(JSON.stringify({ ...payload, exp: now + TOKEN_TTL_MS })).toString("base64url");
	const data = `${VERSION}.${body}`;
	return `${data}.${sign(data, key)}`;
}

/**
 * Devuelve el payload si la firma es válida y no venció; `null` en cualquier otro caso.
 * La comparación de firmas es de tiempo constante: un token es un secreto.
 */
export function verifyUnsubscribeToken(token: string, key: Buffer, now: number = Date.now()): UnsubscribePayload | null {
	const parts = token.split(".");
	if (parts.length !== 3 || parts[0] !== VERSION) return null;
	const expected = sign(`${parts[0]}.${parts[1]}`, key);
	const given = Buffer.from(parts[2]);
	const want = Buffer.from(expected);
	if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;

	try {
		const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as UnsubscribePayload & { exp: number };
		if (!parsed.userId || !parsed.topic || parsed.exp <= now) return null;
		return { userId: parsed.userId, topic: parsed.topic };
	} catch {
		return null;
	}
}
