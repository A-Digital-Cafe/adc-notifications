# NotificationService

Bandeja de notificaciones por usuario (`kernelMode: 80`). Persistencia Mongo en la
base aislada `adc-notifications` (`notifications`, `notification_preferences`).

- **Productores**: `getService<INotificationService>("NotificationService").notify({ userId, topic, title, body, link })`. Degrada si el preset no está cargado.
- **Broadcasts**: `BaseModule.emitBroadcast` → `broadcast(cap, input)`, gateado por scope `notifications:broadcast` (capability opt-in). El servicio encola UN job **firmado con HMAC** (secreto persistido; jobs inyectados sin firma se descartan); fan-out por chunks reanudables (cursor re-publicado) con dedup por `broadcastId`. Sin cola: fan-out directo. `notifySegment(cap, {...input, userIds})` usa la misma maquinaria contra una audiencia enumerada (un job firmado por chunk) y devuelve cuántos destinatarios despachó.
- **Canales**: `inApp` (bandeja + SSE), `email` (opcional: usa `EmailService.sendSystemEmail` si está), `push` (modelado, entrega futura por Web Push).
- **Tiempo real**: SSE en `GET /api/notifications/stream` (auth por cookie de sesión; socket crudo con `reply.hijack()`). Con varios nodos la entrega llega igual (fan-out por el bus del clúster); la afinidad `sse:user:<id>` se reclama sólo para diagnóstico: el endpoint **no** se desvía, desviarlo cortaría un stream ya establecido.
- **REST**: `GET /api/notifications`, `GET .../unread-count`, `POST .../:id/read`, `POST .../read-all`, `DELETE .../:id`, `GET|PUT .../preferences[/:topic]`.
- **Preferencias**: una fila por `(userId, topic)`; sin fila → `DEFAULT_CHANNELS` (`@common/types/notifications`).
- **Baja en un clic**: todo email lleva pie con el topic y `List-Unsubscribe`/`List-Unsubscribe-Post` (RFC 8058) si `NOTIFICATIONS_UNSUBSCRIBE_URL` apunta al `POST /api/notifications/unsubscribe` público. Autoriza un token HMAC del enlace, no la sesión; el GET sólo redirige a preferencias (un prefetch no debe dar de baja). Se omite en topics con `email` obligatorio.
- **Retención**: purga automática diaria de leídas > `NOTIFICATIONS_RETENTION_DAYS`, en un solo nodo (lease `notifications.purge` de `OperationsService`). `purgeUserData(cap, userId)` (scope `identity:internal`) borra bandeja + preferencias en la cascada de baja de cuenta de Identity; `exportUserData` (mismo handshake) las exporta para el export de datos.

Dependencias y env: ver `config.json` y `.env.example`.
