# NotificationService

Bandeja de notificaciones por usuario (`kernelMode: 80`). Persistencia Mongo en la
base aislada `adc-notifications` (`notifications`, `notification_preferences`).

- **Productores**: `getService<INotificationService>("NotificationService").notify({ userId, topic, title, body, link })`. Degrada si el preset no está cargado.
- **Broadcasts**: `BaseModule.emitBroadcast` → `broadcast(cap, input)`, gateado por scope `notifications:broadcast` (capability opt-in). El servicio encola UN job **firmado con HMAC** (secreto persistido; jobs inyectados sin firma se descartan); fan-out por chunks reanudables (cursor re-publicado) con dedup por `broadcastId`. Sin cola: fan-out directo.
- **Canales**: `inApp` (bandeja + SSE), `email` (opcional: usa `EmailService.sendSystemEmail` si está), `push` (modelado, entrega futura por Web Push).
- **Tiempo real**: SSE en `GET /api/notifications/stream` (auth por cookie de sesión; socket crudo con `reply.hijack()`).
- **REST**: `GET /api/notifications`, `GET .../unread-count`, `POST .../:id/read`, `POST .../read-all`, `GET|PUT .../preferences[/:topic]`.
- **Preferencias**: una fila por `(userId, topic)`; sin fila → `DEFAULT_CHANNELS` (`@common/types/notifications`).
- **Retención**: purga automática diaria de leídas > `NOTIFICATIONS_RETENTION_DAYS`. `purgeUserData` para borrado en cascada.

Dependencias y env: ver `config.json` y `.env.example`.
