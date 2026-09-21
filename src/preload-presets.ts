import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { Value } from "typebox/value";
import { loadAgentsDocument } from "./document.ts";
import { type PiPreloadConfiguration, PiPreloadConfigurationSchema } from "./preload-schema.ts";

const PRESET_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MERGED_FIELDS = ["contexts", "excludes", "extends", "includes", "signatures"] as const;

export interface ResolvePreloadPresetsOptions {
	readonly presetDirectory: string;
	readonly signal?: AbortSignal;
}

function withoutPresetReferences(configuration: PiPreloadConfiguration): PiPreloadConfiguration {
	return Object.fromEntries(
		MERGED_FIELDS.flatMap((field) => {
			const values = configuration[field];
			return values?.length ? [[field, [...values]]] : [];
		}),
	);
}

export function mergePreloadConfigurations(configurations: readonly PiPreloadConfiguration[]): PiPreloadConfiguration {
	const merged: Partial<Record<(typeof MERGED_FIELDS)[number], string[]>> = {};
	for (const configuration of configurations) {
		for (const field of MERGED_FIELDS) {
			const values = configuration[field];
			if (!values) continue;
			const selected = merged[field] ?? [];
			const seen = new Set(selected);
			for (const value of values) {
				if (seen.has(value)) continue;
				seen.add(value);
				selected.push(value);
			}
			merged[field] = selected;
		}
	}
	return Object.freeze(merged);
}

export async function resolvePreloadPresets(
	configuration: PiPreloadConfiguration,
	options: ResolvePreloadPresetsOptions,
): Promise<PiPreloadConfiguration> {
	const requestedPresets = configuration.presets ?? [];
	if (requestedPresets.length === 0) return mergePreloadConfigurations([configuration]);
	options.signal?.throwIfAborted();
	const presetRoot = await realpath(resolve(options.presetDirectory));
	const cache = new Map<string, PiPreloadConfiguration>();
	const active = new Set<string>();

	const loadPreset = async (name: string, declaredBy: string): Promise<PiPreloadConfiguration> => {
		options.signal?.throwIfAborted();
		if (!PRESET_NAME_PATTERN.test(name)) throw new Error(`Invalid pi-preload preset name in ${declaredBy}: ${name}`);
		const sourcePath = await realpath(resolve(presetRoot, `${name}.yml`));
		const relativePath = relative(presetRoot, sourcePath);
		if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
			throw new Error(`Pi-preload preset ${name} resolves outside ${presetRoot}.`);
		}
		const cached = cache.get(sourcePath);
		if (cached) return cached;
		if (active.has(sourcePath)) throw new Error(`Circular pi-preload preset in ${declaredBy}: ${sourcePath}`);
		active.add(sourcePath);
		const loaded = await loadAgentsDocument(sourcePath, { signal: options.signal });
		let value: PiPreloadConfiguration;
		try {
			value = Value.Parse(PiPreloadConfigurationSchema, loaded.document);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Invalid pi-preload preset ${sourcePath}: ${detail}`, { cause: error });
		}
		const nested: PiPreloadConfiguration[] = [];
		for (const nestedName of value.presets ?? []) nested.push(await loadPreset(nestedName, sourcePath));
		const resolved = mergePreloadConfigurations([...nested, withoutPresetReferences(value)]);
		active.delete(sourcePath);
		cache.set(sourcePath, resolved);
		return resolved;
	};

	const presets: PiPreloadConfiguration[] = [];
	for (const name of requestedPresets) presets.push(await loadPreset(name, options.presetDirectory));
	return mergePreloadConfigurations([...presets, withoutPresetReferences(configuration)]);
}
