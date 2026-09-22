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

export interface RecursiveAgentsSection {
	readonly extends?: readonly string[];
}

export interface AgentsGraphNode<T> {
	readonly rootPath: string;
	readonly sourcePath: string;
	readonly section: LoadedAgentsSection<T> | undefined;
	readonly depth: number;
}

export interface ResolvedAgentsGraph<T> {
	readonly rootPath: string;
	readonly nodes: readonly AgentsGraphNode<T>[];
}

export interface ResolvedSectionGraphNode<T> extends Omit<AgentsGraphNode<T>, "section"> {
	readonly section: LoadedAgentsSection<T>;
}

export interface ResolvedSectionGraph<T> {
	readonly rootPath: string;
	readonly nodes: readonly ResolvedSectionGraphNode<T>[];
}

export interface ResolvePiPreloadGraphOptions {
	readonly rootPath: string;
	readonly rootValue?: PiPreloadConfiguration;
	readonly presetDirectory?: string;
	readonly signal?: AbortSignal;
}

export interface ResolvePiTreeGraphOptions {
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

export interface ResolveAgentsGraphOptions<TSchemaType extends TSchema, TResolved = Static<TSchemaType>> {
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
	const extensions = (value as RecursiveAgentsSection).extends;
	return extensions ?? [];
}

export async function resolveAgentsGraph<TSchemaType extends TSchema, TResolved = Static<TSchemaType>>(
	options: ResolveAgentsGraphOptions<TSchemaType, TResolved>,
): Promise<ResolvedAgentsGraph<TResolved>> {
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
	const nodes: AgentsGraphNode<TResolved>[] = [];
	const visited = new Set<string>();
	const active = new Set<string>();

	const visit = async (candidatePath: string, depth: number, declaredBy?: string): Promise<void> => {
		options.signal?.throwIfAborted();
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
		if (active.has(currentRoot)) {
			throw new Error(`Circular AGENTS.yml extends in ${declaredBy ?? sourcePath}: ${sourcePath} is already active.`);
		}
		if (visited.has(currentRoot)) return;
		active.add(currentRoot);
		const loadedSection =
			currentRoot === rootPath && options.rootValue !== undefined
				? parseAgentsSection(
						{ sourcePath, document: { [options.sectionName]: options.rootValue } },
						options.sectionName,
						options.schema,
					)
				: await loadAgentsSection(sourcePath, options.sectionName, options.schema, { signal: options.signal });
		const section = options.resolveSection
			? await options.resolveSection(loadedSection, {
					depth,
					rootPath: currentRoot,
					sourcePath,
					signal: options.signal,
				})
			: (loadedSection as LoadedAgentsSection<TResolved> | undefined);
		for (const reference of references(section?.value)) {
			await visit(resolve(dirname(sourcePath), reference), depth + 1, sourcePath);
		}
		active.delete(currentRoot);
		visited.add(currentRoot);
		nodes.push(Object.freeze({ rootPath: currentRoot, sourcePath, section, depth }));
	};

	await visit(rootPath, 0);
	return Object.freeze({ rootPath, nodes: Object.freeze(nodes) });
}

function resolvedSectionGraph<T>(graph: ResolvedAgentsGraph<T>): ResolvedSectionGraph<T> {
	return Object.freeze({
		rootPath: graph.rootPath,
		nodes: Object.freeze(
			graph.nodes.map((node) => {
				if (!node.section) throw new Error(`Resolved section is missing from ${node.sourcePath}.`);
				return Object.freeze({ ...node, section: node.section });
			}),
		),
	});
}

export async function resolvePiPreloadGraph(
	options: ResolvePiPreloadGraphOptions,
): Promise<ResolvedSectionGraph<ResolvedPiPreloadConfiguration>> {
	const graph = await resolveAgentsGraph<typeof PiPreloadConfigurationSchema, ResolvedPiPreloadConfiguration>({
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
	return resolvedSectionGraph(graph);
}

export async function resolvePiTreeGraph(
	options: ResolvePiTreeGraphOptions,
): Promise<ResolvedSectionGraph<ResolvedPiTreeConfiguration>> {
	const graph = await resolveAgentsGraph<typeof PiTreeConfigurationSchema, ResolvedPiTreeConfiguration>({
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
	return resolvedSectionGraph(graph);
}
