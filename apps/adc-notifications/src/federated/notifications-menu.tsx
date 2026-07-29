/**
 * Menú desplegable de notificaciones del header de plataforma.
 *
 * Se expone como remote de Module Federation (`./NotificationsMenu`, ver
 * `config.json` → `federationExposes`) y lo monta `adc-notification-bell`
 * (ui-library) vía el contrato vanilla `mount(container, props) → unmount`.
 * Así la UI de la bandeja vive en este preset y no en la ui-library de núcleo.
 */
import { useEffect, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import "@ui-library/utils/react-jsx";
import { resolvePlatformPath } from "@ui-library/utils/platform-links";
// El chunk expuesto arrastra los estilos: style-loader los inyecta en el host que lo cargue.
import "../styles/tailwind.css";
import { inboxApi as api, notificationHref, useInboxMutations, type NotificationItem } from "../lib/inbox";

export interface NotificationsMenuProps {
	/** Notifica cambios del conteo de no leídas (para el badge de la campana). */
	onUnreadChange?: (unread: number) => void;
}

function NotificationsMenu({ onUnreadChange }: Readonly<NotificationsMenuProps>) {
	const [items, setItems] = useState<NotificationItem[]>([]);
	const [unread, setUnread] = useState(0);
	const [loading, setLoading] = useState(true);

	const syncUnread = useCallback(
		(n: number) => {
			setUnread(n);
			onUnreadChange?.(n);
		},
		[onUnreadChange]
	);

	useEffect(() => {
		let alive = true;
		(async () => {
			const res = await api.get<{ notifications: NotificationItem[]; unread: number }>("", { silent: true });
			if (!alive) return;
			if (res.success) {
				setItems(res.data?.notifications ?? []);
				syncUnread(res.data?.unread ?? 0);
			}
			setLoading(false);
		})();
		return () => {
			alive = false;
		};
	}, [syncUnread]);

	const { readItem, removeItem, readAll } = useInboxMutations(setItems, syncUnread);

	const onItemClick = useCallback(
		async (n: NotificationItem) => {
			await readItem(n);
			const href = notificationHref(n);
			if (href) globalThis.location.href = href;
		},
		[readItem]
	);

	return (
		<div className="w-80 max-w-[calc(100vw-1.5rem)] max-h-112 overflow-hidden rounded-xl bg-surface text-tsurface shadow-cozy ring-1 ring-black/5 flex flex-col">
			<div className="flex items-center justify-between px-4 py-2.5 border-b border-black/10">
				<span className="font-bold text-sm">Notificaciones</span>
				{unread > 0 && (
					<button type="button" className="text-xs text-accent hover:underline" onClick={readAll}>
						Marcar todas como leídas
					</button>
				)}
			</div>
			<div className="overflow-y-auto">
				{loading && <div className="px-4 py-6 text-center text-sm opacity-60">Cargando…</div>}
				{!loading && items.length === 0 && <div className="px-4 py-8 text-center text-sm opacity-60">No tenés notificaciones</div>}
				{!loading &&
					items.map((n) => (
						<div key={n.id} className="flex items-center gap-1 pr-2 border-b border-black/5 hover:bg-black/5 transition-colors">
							<button
								type="button"
								className={`flex-1 min-w-0 text-left px-4 py-3 ${n.readAt ? "opacity-60" : ""}`}
								onClick={() => onItemClick(n)}
							>
								<div className="flex items-start gap-2">
									{!n.readAt && <span className="mt-1.5 w-2 h-2 rounded-full bg-accent shrink-0" />}
									<span className="flex-1 min-w-0">
										<span className="block font-semibold text-sm truncate">{n.title}</span>
										{n.body && <span className="block text-xs opacity-70 line-clamp-2">{n.body}</span>}
									</span>
								</div>
							</button>
							<adc-button-rounded variant="danger" size="md" aria-label="Eliminar notificación" onClick={() => removeItem(n)}>
								<adc-icon-close size="0.75rem" />
							</adc-button-rounded>
						</div>
					))}
			</div>
			<a
				href={resolvePlatformPath("notifications", "/") ?? "#"}
				className="block px-4 py-2.5 text-center text-xs font-semibold text-accent border-t border-black/10 hover:bg-black/5"
			>
				Ver todas las notificaciones
			</a>
		</div>
	);
}

/**
 * Contrato vanilla para hosts no-React (la campana Stencil de la ui-library):
 * monta el menú en `container` y devuelve el disposer para desmontarlo.
 */
export default function mountNotificationsMenu(container: HTMLElement, props: NotificationsMenuProps = {}): () => void {
	const root = createRoot(container);
	root.render(<NotificationsMenu {...props} />);
	return () => root.unmount();
}
