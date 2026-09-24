import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { loadAgentsDocument } from "./document.ts";
import {
	type PiPreloadConfiguration,
	type PiPreloadPresetConfiguration,
	PiPreloadPresetConfigurationSchema,
} from "./preload-schema.ts";

const PRESET_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MERGED_FIELDS = ["contexts", "excludes", "extends", "includes", "signatures"] as const;
const PRESET_DIRECTORY = fileURLToPath(new URL("../presets", import.meta.url));

export interface ResolvePreloadPresetsOptions {
	readonly presetDirectory?: string;
	readonly signal?: AbortSignal;
}

function withoutPresetReferences(configuration: PiPreloadPresetConfiguration): PiPreloadPresetConfiguration {
	return Object.fromEntries(
		MERGED_FIELDS.flatMap((field) => {
			const values = configuration[field];
			return values?.length ? [[field, [...values]]] : [];
		}),
	);
}

export function mergePreloadConfigurations(
	configurations: readonly PiPreloadPresetConfiguration[],
): PiPreloadPresetConfiguration {
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
): Promise<PiPreloadPresetConfiguration> {
	const requestedPresets = configuration.presets ?? [];
	if (requestedPresets.length === 0) return mergePreloadConfigurations([configuration]);
	options.signal?.throwIfAborted();
	const packagePresetRoot = await realpath(resolve(PRESET_DIRECTORY));
	const presetRoots = [packagePresetRoot];
	if (options.presetDirectory) {
		const additionalPresetRoot = await realpath(resolve(options.presetDirectory));
		if (additionalPresetRoot !== packagePresetRoot) presetRoots.push(additionalPresetRoot);
	}
	const cache = new Map<string, PiPreloadPresetConfiguration>();
	const active = new Set<string>();

	const loadPreset = async (name: string, declaredBy: string): Promise<PiPreloadPresetConfiguration> => {
		options.signal?.throwIfAborted();
		if (!PRESET_NAME_PATTERN.test(name)) throw new Error(`Invalid pi-preload preset name in ${declaredBy}: ${name}`);
		let sourcePath: string | undefined;
		for (const presetRoot of presetRoots) {
			try {
				const candidatePath = await realpath(resolve(presetRoot, `${name}.yml`));
				const relativePath = relative(presetRoot, candidatePath);
				if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
					throw new Error(`Pi-preload preset ${name} resolves outside ${presetRoot}.`);
				}
				sourcePath = candidatePath;
				break;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
		}
		if (!sourcePath) throw new Error(`Could not resolve pi-preload preset ${name} declared by ${declaredBy}.`);
		const cached = cache.get(sourcePath);
		if (cached) return cached;
		if (active.has(sourcePath)) throw new Error(`Circular pi-preload preset in ${declaredBy}: ${sourcePath}`);
		active.add(sourcePath);
		const loaded = await loadAgentsDocument(sourcePath, { signal: options.signal });
		let value: PiPreloadPresetConfiguration;
		try {
			value = Value.Parse(PiPreloadPresetConfigurationSchema, loaded.document);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Invalid pi-preload preset ${sourcePath}: ${detail}`, { cause: error });
		}
		const nested: PiPreloadPresetConfiguration[] = [];
		for (const nestedName of value.presets ?? []) nested.push(await loadPreset(nestedName, sourcePath));
		const resolved = mergePreloadConfigurations([...nested, withoutPresetReferences(value)]);
		active.delete(sourcePath);
		cache.set(sourcePath, resolved);
		return resolved;
	};

	const presets: PiPreloadPresetConfiguration[] = [];
	for (const name of requestedPresets) presets.push(await loadPreset(name, PRESET_DIRECTORY));
	return mergePreloadConfigurations([...presets, withoutPresetReferences(configuration)]);
}
