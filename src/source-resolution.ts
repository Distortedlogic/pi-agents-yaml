import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Static, TSchema } from "typebox";
import { AGENTS_FILE_NAME } from "./document.ts";
import { resolvePreloadPresets } from "./preload-presets.ts";
import {
	type PiPreloadConfiguration,
	PiPreloadConfigurationSchema,
	type PiTreeConfiguration,
	PiTreeConfigurationSchema,
	type ResolvedPiPreloadConfiguration,
	type ResolvedPiTreeConfiguration,
	resolvePiPreloadConfiguration,
	resolvePiTreeConfiguration,
} from "./preload-schema.ts";
import { type LoadedAgentsSection, loadAgentsSection, parseAgentsSection } from "./section.ts";

export interface AgentsSectionWithExtends {
	readonly extends?: readonly string[];
}

export interface ResolvedAgentsSource<T> {
	readonly rootPath: string;
	readonly sourcePath: string;
	readonly section: LoadedAgentsSection<T> | undefined;
	readonly depth: number;
}

export interface ResolvedAgentsSources<T> {
	readonly rootPath: string;
	readonly sources: readonly ResolvedAgentsSource<T>[];
}

export interface ResolvedSectionSource<T> extends Omit<ResolvedAgentsSource<T>, "section"> {
	readonly section: LoadedAgentsSection<T>;
}

export interface ResolvedSectionSources<T> {
	readonly rootPath: string;
	readonly sources: readonly ResolvedSectionSource<T>[];
}

export interface ResolvePiPreloadSourcesOptions {
	readonly rootPath: string;
	readonly rootValue?: PiPreloadConfiguration;
	readonly presetDirectory?: string;
	readonly signal?: AbortSignal;
}

export interface ResolvePiTreeSourcesOptions {
	readonly rootPath: string;
	readonly rootValue?: PiTreeConfiguration;
	readonly signal?: AbortSignal;
}

export interface ResolveAgentsSectionContext {
	readonly depth: number;
	readonly rootPath: string;
	readonly sourcePath: string;
	readonly signal?: AbortSignal;
}

export interface ResolveAgentsSourcesOptions<TSchemaType extends TSchema, TResolved = Static<TSchemaType>> {
	readonly rootPath: string;
	readonly sectionName: string;
	readonly schema: TSchemaType;
	readonly rootValue?: Static<TSchemaType>;
	readonly signal?: AbortSignal;
	readonly resolveSection?: (
		section: LoadedAgentsSection<Static<TSchemaType>> | undefined,
		context: ResolveAgentsSectionContext,
	) => LoadedAgentsSection<TResolved> | undefined | Promise<LoadedAgentsSection<TResolved> | undefined>;
}

function references(value: unknown): readonly string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	return (value as AgentsSectionWithExtends).extends ?? [];
}

export const MAX_AGENTS_EXTENDS_DEPTH = 3;

export async function resolveAgentsSources<TSchemaType extends TSchema, TResolved = Static<TSchemaType>>(
	options: ResolveAgentsSourcesOptions<TSchemaType, TResolved>,
): Promise<ResolvedAgentsSources<TResolved>> {
	options.signal?.throwIfAborted();
	const requestedRootPath = resolve(options.rootPath);
	const rootSourcePath = join(requestedRootPath, AGENTS_FILE_NAME);
	let rootPath: string;
	try {
		rootPath = await realpath(requestedRootPath);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not resolve AGENTS.yml root ${rootSourcePath}: ${detail}`, { cause: error });
	}
	const sources: ResolvedAgentsSource<TResolved>[] = [];
	const completed = new Set<string>();
	const activePath = new Set<string>();

	const resolveSource = async (candidatePath: string, depth: number, declaredBy?: string): Promise<void> => {
		options.signal?.throwIfAborted();
		if (depth > MAX_AGENTS_EXTENDS_DEPTH) {
			const sourcePath = join(resolve(candidatePath), AGENTS_FILE_NAME);
			throw new Error(
				`AGENTS.yml extends in ${declaredBy ?? rootSourcePath} exceeds the maximum depth of ${MAX_AGENTS_EXTENDS_DEPTH} at ${sourcePath}.`,
			);
		}
		let currentRoot: string;
		try {
			currentRoot = await realpath(resolve(candidatePath));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Could not resolve AGENTS.yml root declared by ${declaredBy ?? rootSourcePath}: ${detail}`, {
				cause: error,
			});
		}
		const sourcePath = join(currentRoot, AGENTS_FILE_NAME);
		if (activePath.has(currentRoot)) {
			throw new Error(`Circular AGENTS.yml extends in ${declaredBy ?? sourcePath}: ${sourcePath} is already active.`);
		}
		if (completed.has(currentRoot)) return;
		activePath.add(currentRoot);
		const loadedSection =
			currentRoot === rootPath && options.rootValue !== undefined
				? parseAgentsSection(
						{ sourcePath, document: { [options.sectionName]: options.rootValue } },
						options.sectionName,
						options.schema,
					)
				: existsSync(sourcePath)
					? await loadAgentsSection(sourcePath, options.sectionName, options.schema, { signal: options.signal })
					: undefined;
		const section = options.resolveSection
			? await options.resolveSection(loadedSection, {
					depth,
					rootPath: currentRoot,
					sourcePath,
					signal: options.signal,
				})
			: (loadedSection as LoadedAgentsSection<TResolved> | undefined);
		for (const reference of references(section?.value)) {
			await resolveSource(resolve(dirname(sourcePath), reference), depth + 1, sourcePath);
		}
		activePath.delete(currentRoot);
		completed.add(currentRoot);
		sources.push(Object.freeze({ rootPath: currentRoot, sourcePath, section, depth }));
	};

	await resolveSource(rootPath, 0);
	return Object.freeze({ rootPath, sources: Object.freeze(sources) });
}

function resolvedSectionSources<T>(resolution: ResolvedAgentsSources<T>): ResolvedSectionSources<T> {
	return Object.freeze({
		rootPath: resolution.rootPath,
		sources: Object.freeze(
			resolution.sources.map((source) => {
				if (!source.section) throw new Error(`Resolved section is missing from ${source.sourcePath}.`);
				return Object.freeze({ ...source, section: source.section });
			}),
		),
	});
}

export async function resolvePiPreloadSources(
	options: ResolvePiPreloadSourcesOptions,
): Promise<ResolvedSectionSources<ResolvedPiPreloadConfiguration>> {
	const resolution = await resolveAgentsSources<typeof PiPreloadConfigurationSchema, ResolvedPiPreloadConfiguration>({
		rootPath: options.rootPath,
		sectionName: "pi-preload",
		schema: PiPreloadConfigurationSchema,
		...(options.rootValue ? { rootValue: options.rootValue } : {}),
		signal: options.signal,
		resolveSection: async (section, context) => {
			const configuration = section
				? await resolvePreloadPresets(section.value, {
						...(options.presetDirectory ? { presetDirectory: options.presetDirectory } : {}),
						signal: context.signal,
					})
				: undefined;
			return Object.freeze({
				name: "pi-preload",
				sourcePath: context.sourcePath,
				value: resolvePiPreloadConfiguration(configuration),
			});
		},
	});
	return resolvedSectionSources(resolution);
}

export async function resolvePiTreeSources(
	options: ResolvePiTreeSourcesOptions,
): Promise<ResolvedSectionSources<ResolvedPiTreeConfiguration>> {
	const resolution = await resolveAgentsSources<typeof PiTreeConfigurationSchema, ResolvedPiTreeConfiguration>({
		rootPath: options.rootPath,
		sectionName: "pi-tree",
		schema: PiTreeConfigurationSchema,
		...(options.rootValue ? { rootValue: options.rootValue } : {}),
		signal: options.signal,
		resolveSection: (section, context) =>
			Object.freeze({
				name: "pi-tree",
				sourcePath: context.sourcePath,
				value: resolvePiTreeConfiguration(section?.value),
			}),
	});
	return resolvedSectionSources(resolution);
}
