import { useEffect, useState } from "react";
import { createAdcApi } from "@ui-library/utils/adc-fetch";
import { PLATFORM_TOPIC_LIST } from "@common/utils/notifications/platform-topics.ts";
// Se importa el CSS porque el panel se expone como remote y lo monta `my-account`, que no
// escanea este árbol: sin esto sus clases Tailwind no existen allá.
import "../styles/tailwind.css";

/**
 * Panel de preferencias de los avisos **de plataforma**, expuesto como remote
 * (`./AccountSettings`) y consumido por el host `my-account`. Mismo contrato que el panel de Drive:
 * lee/escribe por `topic` contra `/api/notifications/preferences`.
 *
 * Los canales obligatorios de un topic (el aviso in-app de cambios legales) se pintan marcados y
 * deshabilitados, con el motivo a la vista. El backend los reimpone igual —el guard vive en
 * `PreferenceManager`—; acá se muestran así para que la restricción se entienda en vez de parecer
 * un bug cuando el interruptor no responde.
 */
const api = createAdcApi({ basePath: "/api/notifications", devPort: 3000 });

interface Pref {
	topic: string;
	inApp: boolean;
	email: boolean;
	push: boolean;
}

type Channel = "inApp" | "email";

const CHANNEL_LABELS: Record<Channel, string> = { inApp: "App", email: "Email" };

export default function AccountSettings() {
	const [ready, setReady] = useState(false);
	const [available, setAvailable] = useState(false);
	const [prefs, setPrefs] = useState<Record<string, Pref>>({});

	useEffect(() => {
		let alive = true;
		(async () => {
			const res = await api.get<{ preferences: Pref[] }>("/preferences", { silent: true });
			if (!alive) return;
			if (res.success) {
				const map: Record<string, Pref> = {};
				for (const p of res.data?.preferences ?? []) map[p.topic] = p;
				setPrefs(map);
				setAvailable(true);
			}
			setReady(true);
		})();
		return () => {
			alive = false;
		};
	}, []);

	const valueOf = (topic: string, channel: Channel): boolean => {
		const p = prefs[topic];
		if (p) return p[channel];
		// Default: inApp activo, email inactivo (coincide con DEFAULT_CHANNELS del backend).
		return channel === "inApp";
	};

	const toggle = async (topic: string, channel: Channel) => {
		const next = !valueOf(topic, channel);
		const current = prefs[topic] ?? { topic, inApp: true, email: false, push: false };
		const optimistic = { ...current, [channel]: next };
		setPrefs((prev) => ({ ...prev, [topic]: optimistic }));
		const res = await api.put<Pref>(`/preferences/${topic}`, { body: { [channel]: next }, silent: true });
		if (res.success && res.data) setPrefs((prev) => ({ ...prev, [topic]: res.data as Pref }));
	};

	if (!ready) return null;
	if (!available) return null;

	return (
		<section className="rounded-xl bg-surface text-tsurface shadow-cozy border border-text/15 px-6 py-5 mb-4">
			<h3 className="font-bold text-base mb-1">Plataforma</h3>
			<p className="text-sm opacity-70 mb-4">Avisos que ADC manda a todas las personas usuarias.</p>
			<ul className="divide-y divide-black/5">
				{PLATFORM_TOPIC_LIST.map((td) => (
					<li key={td.topic} className="flex items-start justify-between gap-4 py-3">
						{/* El contenedor de my-account es `xl:w-max`: su ancho lo fija el `max-content` del
						    contenido, así que una descripción larga en una sola línea ensancha la página
						    entera —incluidos los paneles vecinos—. `max-w-xl` acota ese `max-content` y
						    `min-w-0` deja que el texto se encoja en pantallas chicas. */}
						<div className="flex-1 min-w-0 max-w-xl">
							<p className="text-sm">{td.label}</p>
							<p className="text-xs opacity-60 mt-0.5">{td.description}</p>
						</div>
						<div className="flex items-center gap-4 shrink-0 pt-0.5">
							{(Object.keys(CHANNEL_LABELS) as Channel[]).map((ch) => {
								const locked = td.mandatoryChannels.includes(ch);
								return (
									// `visualEnabled` con `disabled`: el canal obligatorio se ve encendido y opaco,
									// no apagado ni gris, para que se lea como regla y no como control roto.
									<adc-toggle
										key={ch}
										size="small"
										label={CHANNEL_LABELS[ch]}
										checked={locked || valueOf(td.topic, ch)}
										disabled={locked}
										visualEnabled={locked}
										hint={locked ? "Este aviso es obligatorio y no se puede desactivar" : undefined}
										onadcChange={() => !locked && toggle(td.topic, ch)}
									/>
								);
							})}
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}
