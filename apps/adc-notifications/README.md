# adc-notifications (app)

Historial completo de notificaciones del usuario (la campana del header muestra solo
las recientes). React + `@ui-library`. `devPort: 3036`, subdominio `notifications`.

Consume `NotificationService` vía `/api/notifications` (lista paginada por cursor,
marcar leída/todas, eliminar). Resuelve los enlaces con `resolvePlatformPath` (dev
port / prod subdominio). Si el backend no está, muestra el estado vacío.

Expone `./NotificationsMenu` (Module Federation, contrato `mount(container, props)`):
el dropdown de la campana del header (`adc-notification-bell` sólo pinta botón+badge).
Si esta app está caída, la campana avisa con un toast al abrirla.
