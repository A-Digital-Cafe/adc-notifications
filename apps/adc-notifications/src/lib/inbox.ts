/**
 * Cliente compartido de la bandeja de notificaciones: lo usan la página
 * principal (`App.tsx`) y el menú federado del header (`federated/notifications-menu.tsx`).
 */
import { useCallback, type Dispatch, type SetStateAction } from "react";
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

/**
 * Mutaciones de la bandeja con reflejo local del estado. Si la request falla no
 * se toca la UI (el cambio reaparecería al recargar); el badge sólo se mueve
 * cuando el server devuelve conteo.
 */
export function useInboxMutations(setItems: Dispatch<SetStateAction<NotificationItem[]>>, syncUnread: (unread: number) => void) {
	const readItem = useCallback(
		async (n: NotificationItem) => {
			if (n.readAt) return;
			const res = await inboxApi.post<{ unread: number }>(`/${n.id}/read`, { silent: true });
			if (!res.success) return;
			if (res.data) syncUnread(res.data.unread);
			setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
		},
		[setItems, syncUnread]
	);

	const removeItem = useCallback(
		async (n: NotificationItem) => {
			const res = await inboxApi.delete<{ unread: number }>(`/${n.id}`, { silent: true });
			if (!res.success) return;
			if (res.data) syncUnread(res.data.unread);
			setItems((prev) => prev.filter((x) => x.id !== n.id));
		},
		[setItems, syncUnread]
	);

	const readAll = useCallback(async () => {
		const res = await inboxApi.post("/read-all", { silent: true });
		if (!res.success) return;
		syncUnread(0);
		setItems((prev) => prev.map((x) => (x.readAt ? x : { ...x, readAt: new Date().toISOString() })));
	}, [setItems, syncUnread]);

	return { readItem, removeItem, readAll };
}
