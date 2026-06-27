# adc-notifications [![Security](https://github.com/A-Digital-Cafe/adc-notifications/actions/workflows/security.yml/badge.svg)](https://github.com/A-Digital-Cafe/adc-notifications/actions/workflows/security.yml)

Preset de notificaciones de la plataforma ADC.

Contiene `NotificationService` (`kernelMode: 80`): bandeja por usuario en Mongo
(base aislada `adc-notifications`), preferencias por `topic`/canal, entrega en
tiempo real por **SSE** (`/api/notifications/stream`) y canal **email opcional**
(si `EmailService` está cargado e implementa `sendSystemEmail`).

Productores: cualquier servicio resuelve `INotificationService`
(`@common/types/notifications`) y llama `notify(...)`; degrada si el preset no está.
La campana (`adc-notification-bell`) vive en la UI library de núcleo y se auto-oculta
si el servicio no responde. Push PWA (Web Push/VAPID) queda como extensión futura
(canal `push` ya modelado).

Variables: `NOTIFICATIONS_DB_NAME`, `NOTIFICATIONS_RETENTION_DAYS`,
`NOTIFICATIONS_SYSTEM_FROM` (remitente del canal email).
