import { useEffect, useState, useCallback } from "react";
import "@ui-library/utils/react-jsx";
import { getSession } from "@ui-library/utils/session";
import { createAdcApi } from "@ui-library/utils/adc-fetch";
import { resolvePlatformPath } from "@ui-library/utils/platform-links";

interface NotificationItem {
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

const api = createAdcApi({ basePath: "/api/notifications", devPort: 3000 });
const PAGE = 50;

function href(n: NotificationItem): string | null {
	if (!n.link) return null;
	if (n.linkApp) return resolvePlatformPath(n.linkApp, n.link) ?? n.link;
	return n.link;
}

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
		if (!res.success || !res.data) return;
		setUnread(res.data.unread);
		setItems((prev) => (before ? [...prev, ...res.data!.notifications] : res.data!.notifications));
		if (res.data.notifications.length < PAGE) setDone(true);
	}, []);

	useEffect(() => {
		let alive = true;
		(async () => {
			const session = await getSession(false, true);
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

	const onItemClick = useCallback(async (n: NotificationItem) => {
		if (!n.readAt) {
			const res = await api.post<{ unread: number }>(`/${n.id}/read`, { silent: true });
			// Reflejar la lectura sólo si el server la persistió (si no, reaparece al recargar).
			if (res.success && res.data) {
				setUnread(res.data.unread);
				setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
			}
		}
		const url = href(n);
		if (url) globalThis.location.href = url;
	}, []);

	const markAllRead = useCallback(async () => {
		const res = await api.post("/read-all", { silent: true });
		if (res.success) {
			setUnread(0);
			setItems((prev) => prev.map((x) => (x.readAt ? x : { ...x, readAt: new Date().toISOString() })));
		}
	}, []);

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
						<button type="button" className="text-sm text-accent hover:underline" onClick={markAllRead}>
							Marcar todas como leídas
						</button>
					)}
				</div>

				{items.length === 0 ? (
					<div className="text-center text-muted py-16">No tenés notificaciones.</div>
				) : (
					<ul className="rounded-xl overflow-hidden ring-1 ring-black/5 bg-surface text-tsurface divide-y divide-black/5">
						{items.map((n) => (
							<li key={n.id}>
								<button
									type="button"
									className={`w-full text-left px-4 py-3.5 hover:bg-black/5 transition-colors ${n.readAt ? "opacity-60" : ""}`}
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
							onClick={() => load(items[items.length - 1]?.createdAt)}
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
