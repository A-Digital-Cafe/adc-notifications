/**
 * Cliente compartido de la bandeja de notificaciones: lo usan la página
 * principal (`App.tsx`) y el menú federado del header (`federated/notifications-menu.tsx`).
 */
import { createAdcApi } from "@ui-library/utils/adc-fetch";
import { resolvePlatformPath } from "@ui-library/utils/platform-links";

export interface NotificationItem {
	id: string;
	topic: string;
	title: string;
	body: string;
	icon?: string | null;
	link?: string | null;
	linkApp?: string | null;
	readAt?: string | null;
	createdAt: string;
}

export const inboxApi = createAdcApi({ basePath: "/api/notifications", devPort: 3000 });

/** URL final del enlace de una notificación: ruta de app resuelta o URL absoluta. */
export function notificationHref(n: NotificationItem): string | null {
	if (!n.link) return null;
	if (n.linkApp) return resolvePlatformPath(n.linkApp, n.link) ?? n.link;
	return n.link;
}

/** Marca una notificación como leída; devuelve el nuevo conteo o `null` si falló. */
export async function markRead(id: string): Promise<number | null> {
	const res = await inboxApi.post<{ unread: number }>(`/${id}/read`, { silent: true });
	return res.success && res.data ? res.data.unread : null;
}

/** Elimina una notificación; devuelve el nuevo conteo o `null` si falló. */
export async function deleteNotification(id: string): Promise<number | null> {
	const res = await inboxApi.delete<{ unread: number }>(`/${id}`, { silent: true });
	return res.success && res.data ? res.data.unread : null;
}
