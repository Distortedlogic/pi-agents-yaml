import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Static, TSchema } from "typebox";
import { AGENTS_FILE_NAME } from "./document.ts";
import { resolvePreloadPresets } from "./preload-presets.ts";
import type { PiPreloadConfiguration } from "./preload-schema.ts";
import { type LoadedAgentsSection, loadAgentsSection } from "./section.ts";

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

export interface ResolveAgentsGraphOptions<TSchemaType extends TSchema> {
	readonly rootPath: string;
	readonly sectionName: string;
	readonly schema: TSchemaType;
	readonly rootValue?: Static<TSchemaType>;
	readonly presetDirectory?: string;
	readonly signal?: AbortSignal;
}

function references(value: unknown): readonly string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const extensions = (value as RecursiveAgentsSection).extends;
	return extensions ?? [];
}

export async function resolveAgentsGraph<TSchemaType extends TSchema>(
	options: ResolveAgentsGraphOptions<TSchemaType>,
): Promise<ResolvedAgentsGraph<Static<TSchemaType>>> {
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
	const nodes: AgentsGraphNode<Static<TSchemaType>>[] = [];
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
		let section =
			currentRoot === rootPath && options.rootValue !== undefined
				? Object.freeze({ name: options.sectionName, sourcePath, value: options.rootValue })
				: await loadAgentsSection(sourcePath, options.sectionName, options.schema, { signal: options.signal });
		if (section && options.presetDirectory && options.sectionName === "pi-preload") {
			section = Object.freeze({
				...section,
				value: (await resolvePreloadPresets(section.value as PiPreloadConfiguration, {
					presetDirectory: options.presetDirectory,
					signal: options.signal,
				})) as Static<TSchemaType>,
			});
		}
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
