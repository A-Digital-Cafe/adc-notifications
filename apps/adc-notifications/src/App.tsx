import { useEffect, useState, useCallback } from "react";
import "@ui-library/utils/react-jsx";
import { getSession } from "@ui-library/utils/session";
import { inboxApi as api, notificationHref as href, useInboxMutations, type NotificationItem } from "./lib/inbox";

const PAGE = 50;

function formatDate(iso: string): string {
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return "";
	}
}

export default function App() {
	const [status, setStatus] = useState<"loading" | "anon" | "ready">("loading");
	const [items, setItems] = useState<NotificationItem[]>([]);
	const [unread, setUnread] = useState(0);
	const [done, setDone] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);

	const load = useCallback(async (before?: string) => {
		setLoadingMore(true);
		const res = await api.get<{ notifications: NotificationItem[]; unread: number }>("", {
			params: { limit: PAGE, ...(before ? { before } : {}) },
			silent: true,
		});
		setLoadingMore(false);
		if (!res.success) return;
		// 204: bandeja vacía (primera página) o fin del cursor (paginando).
		if (!res.data) {
			if (!before) {
				setItems([]);
				setUnread(0);
			}
			setDone(true);
			return;
		}
		setUnread(res.data.unread);
		setItems((prev) => (before ? [...prev, ...res.data!.notifications] : res.data!.notifications));
		if (res.data.notifications.length < PAGE) setDone(true);
	}, []);

	useEffect(() => {
		let alive = true;
		(async () => {
			const session = await getSession(false);
			if (!alive) return;
			if (!session.authenticated) {
				setStatus("anon");
				return;
			}
			setStatus("ready");
			await load();
		})();
		return () => {
			alive = false;
		};
	}, [load]);

	const { readItem, removeItem, readAll } = useInboxMutations(setItems, setUnread);

	const onItemClick = useCallback(
		async (n: NotificationItem) => {
			await readItem(n);
			const url = href(n);
			if (url) globalThis.location.href = url;
		},
		[readItem]
	);

	let body: React.ReactNode;
	if (status === "loading") {
		body = <adc-skeleton variant="rectangular" height="400px" />;
	} else if (status === "anon") {
		body = (
			<div className="max-w-2xl mx-auto px-4 py-16 text-center">
				<h1 className="text-2xl font-bold mb-3">Notificaciones</h1>
				<p className="text-muted">Iniciá sesión para ver tus notificaciones.</p>
			</div>
		);
	} else {
		body = (
			<div className="max-w-2xl mx-auto px-4 py-8 animate-fade-in">
				<div className="flex items-center justify-between mb-6">
					<h1 className="text-2xl font-bold">
						Notificaciones {unread > 0 && <span className="text-base text-accent">({unread} sin leer)</span>}
					</h1>
					{unread > 0 && (
						<button type="button" className="text-sm text-accent hover:underline" onClick={readAll}>
							Marcar todas como leídas
						</button>
					)}
				</div>

				{items.length === 0 ? (
					<div className="text-center text-muted py-16">No tenés notificaciones.</div>
				) : (
					<ul className="rounded-xl overflow-hidden ring-1 ring-black/5 bg-surface text-tsurface divide-y divide-black/5">
						{items.map((n) => (
							<li key={n.id} className="flex items-center gap-2 pr-3 hover:bg-black/5 transition-colors">
								<button
									type="button"
									className={`flex-1 min-w-0 text-left px-4 py-3.5 ${n.readAt ? "opacity-60" : ""}`}
									onClick={() => onItemClick(n)}
								>
									<div className="flex items-start gap-3">
										{!n.readAt && <span className="mt-1.5 w-2 h-2 rounded-full bg-accent shrink-0" />}
										<span className="flex-1 min-w-0">
											<span className="block font-semibold text-sm">{n.title}</span>
											{n.body && <span className="block text-sm opacity-70">{n.body}</span>}
											<span className="block text-xs opacity-50 mt-1">{formatDate(n.createdAt)}</span>
										</span>
									</div>
								</button>
								<adc-button-rounded variant="danger" size="md" aria-label="Eliminar notificación" onClick={() => removeItem(n)}>
									<adc-icon-close size="0.875rem" />
								</adc-button-rounded>
							</li>
						))}
					</ul>
				)}

				{!done && items.length > 0 && (
					<div className="text-center mt-6">
						<button
							type="button"
							className="px-4 py-2 text-sm rounded-lg ring-1 ring-black/10 hover:bg-black/5 disabled:opacity-50"
							disabled={loadingMore}
							onClick={() => load(items.at(-1)?.createdAt)}
						>
							{loadingMore ? "Cargando…" : "Cargar más"}
						</button>
					</div>
				)}
			</div>
		);
	}

	// adc-layout (shadow:false) reposiciona físicamente su hijo slotted dentro de su <main>,
	// por lo que su hijo directo debe ser un wrapper ESTABLE que React nunca remueva (si
	// cambiase, React intentaría removerlo desde adc-layout y ya no es su hijo → removeChild).
	// El remount por estado (loading/anon/ready) se hace en un div interno (nieto), que vive
	// dentro del wrapper estable y React reconcilia sin problema (ver docs/architecture/ui-federation.md #2).
	return (
		<adc-layout>
			<div>
				<div key={status}>{body}</div>
			</div>
		</adc-layout>
	);
}
