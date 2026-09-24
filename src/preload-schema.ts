import { type Static, Type } from "typebox";

const exact = { additionalProperties: false } as const;
const StringListSchema = Type.Array(Type.String({ minLength: 1 }));

export const PiPreloadConfigurationSchema = Type.Object(
	{
		contexts: Type.Optional(StringListSchema),
		extends: Type.Optional(StringListSchema),
		presets: Type.Optional(StringListSchema),
	},
	exact,
);

export const PiPreloadPresetConfigurationSchema = Type.Object(
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

export const PiTreeConfigurationSchema = Type.Object(
	{
		excludes: Type.Optional(StringListSchema),
		extends: Type.Optional(StringListSchema),
	},
	exact,
);

export type PiPreloadConfiguration = Static<typeof PiPreloadConfigurationSchema>;
export type PiPreloadPresetConfiguration = Static<typeof PiPreloadPresetConfigurationSchema>;
export type PiTreeConfiguration = Static<typeof PiTreeConfigurationSchema>;

export interface ResolvedPiPreloadConfiguration {
	readonly contexts: readonly string[];
	readonly excludes: readonly string[];
	readonly extends: readonly string[];
	readonly includes: readonly string[];
	readonly presets: readonly string[];
	readonly signatures: readonly string[];
}

export interface ResolvedPiTreeConfiguration {
	readonly excludes: readonly string[];
	readonly extends: readonly string[];
}

export const PI_PRELOAD_CONFIGURATION_DEFAULTS: ResolvedPiPreloadConfiguration = Object.freeze({
	contexts: Object.freeze([]),
	excludes: Object.freeze([]),
	extends: Object.freeze([]),
	includes: Object.freeze([]),
	presets: Object.freeze([]),
	signatures: Object.freeze([]),
});

export const PI_TREE_CONFIGURATION_DEFAULTS: ResolvedPiTreeConfiguration = Object.freeze({
	excludes: Object.freeze([]),
	extends: Object.freeze([]),
});

export function resolvePiPreloadConfiguration(
	configuration?: PiPreloadPresetConfiguration,
): ResolvedPiPreloadConfiguration {
	return Object.freeze({
		contexts: Object.freeze([...(configuration?.contexts ?? PI_PRELOAD_CONFIGURATION_DEFAULTS.contexts)]),
		excludes: Object.freeze([...(configuration?.excludes ?? PI_PRELOAD_CONFIGURATION_DEFAULTS.excludes)]),
		extends: Object.freeze([...(configuration?.extends ?? PI_PRELOAD_CONFIGURATION_DEFAULTS.extends)]),
		includes: Object.freeze([...(configuration?.includes ?? PI_PRELOAD_CONFIGURATION_DEFAULTS.includes)]),
		presets: Object.freeze([...(configuration?.presets ?? PI_PRELOAD_CONFIGURATION_DEFAULTS.presets)]),
		signatures: Object.freeze([...(configuration?.signatures ?? PI_PRELOAD_CONFIGURATION_DEFAULTS.signatures)]),
	});
}

export function resolvePiTreeConfiguration(configuration?: PiTreeConfiguration): ResolvedPiTreeConfiguration {
	return Object.freeze({
		excludes: Object.freeze([...(configuration?.excludes ?? PI_TREE_CONFIGURATION_DEFAULTS.excludes)]),
		extends: Object.freeze([...(configuration?.extends ?? PI_TREE_CONFIGURATION_DEFAULTS.extends)]),
	});
}

export const piPreloadConfigurationSchema = PiPreloadConfigurationSchema;
export const piTreeConfigurationSchema = PiTreeConfigurationSchema;
