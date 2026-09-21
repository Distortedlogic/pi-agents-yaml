import { type Static, Type } from "typebox";

const exact = { additionalProperties: false } as const;
const StringListSchema = Type.Array(Type.String({ minLength: 1 }));

export const PiPreloadConfigurationSchema = Type.Object(
	{
		contexts: Type.Optional(StringListSchema),
		excludes: Type.Optional(StringListSchema),
		extends: Type.Optional(StringListSchema),
		includes: Type.Optional(StringListSchema),
		presets: Type.Optional(StringListSchema),
		signatures: Type.Optional(StringListSchema),
	},
	exact,
);

export const piPreloadConfigurationSchema = PiPreloadConfigurationSchema;
export type PiPreloadConfiguration = Static<typeof PiPreloadConfigurationSchema>;
