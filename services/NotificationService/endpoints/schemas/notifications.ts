import { Type } from "@sinclair/typebox";

export const ListQuery = Type.Object({
	limit: Type.Optional(Type.String({ description: "Máx 50" })),
	before: Type.Optional(Type.String({ description: "Cursor ISO: notificaciones anteriores a esta fecha" })),
});

export const NotificationIdParams = Type.Object({
	id: Type.String(),
});

const NotificationObject = Type.Object({
	id: Type.String(),
	userId: Type.String(),
	orgId: Type.Union([Type.String(), Type.Null()]),
	topic: Type.String(),
	title: Type.String(),
	body: Type.String(),
	icon: Type.Union([Type.String(), Type.Null()]),
	link: Type.Union([Type.String(), Type.Null()]),
	linkApp: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	data: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
	channels: Type.Array(Type.String()),
	readAt: Type.Union([Type.String(), Type.Null()]),
	createdAt: Type.String(),
});

export const ListResponse = Type.Object({
	notifications: Type.Array(NotificationObject),
	unread: Type.Integer(),
});

export const UnreadCountResponse = Type.Object({
	unread: Type.Integer(),
});

export const ReadResponse = Type.Object({
	ok: Type.Boolean(),
	unread: Type.Integer(),
});
