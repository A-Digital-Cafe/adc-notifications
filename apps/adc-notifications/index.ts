import { BaseApp } from "@apps/BaseApp.js";

/**
 * Notifications App — historial completo de notificaciones del usuario
 * (la campana del header muestra solo las recientes; esta app las muestra todas).
 */
export default class NotificationsApp extends BaseApp {
	async run() {
		this.logger.logOk(`${this.name} ejecutándose`);
	}
}
