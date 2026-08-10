import { Type } from "@sinclair/typebox";

export const TopicParams = Type.Object({
	topic: Type.String(),
});

const PreferenceObject = Type.Object({
	userId: Type.String(),
	topic: Type.String(),
	inApp: Type.Boolean(),
	email: Type.Boolean(),
	push: Type.Boolean(),
	updatedAt: Type.String(),
});

export const PreferencesListResponse = Type.Object({
	preferences: Type.Array(PreferenceObject),
});

export const SetPreferenceBody = Type.Object({
	inApp: Type.Optional(Type.Boolean()),
	email: Type.Optional(Type.Boolean()),
	push: Type.Optional(Type.Boolean()),
});

export const SetPreferenceResponse = PreferenceObject;

export const UnsubscribeQuery = Type.Object({
	token: Type.Optional(Type.String({ description: "Token firmado del enlace de baja del correo" })),
});

export const UnsubscribeResponse = Type.Object({
	unsubscribed: Type.Boolean(),
	topic: Type.Union([Type.String(), Type.Null()], { description: "Topic dado de baja; null si el token no era válido" }),
});
