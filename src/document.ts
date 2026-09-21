import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export const AGENTS_FILE_NAME = "AGENTS.yml";

export type AgentsDocument = Readonly<Record<string, unknown>>;

export interface LoadedAgentsDocument {
	readonly sourcePath: string;
	readonly document: AgentsDocument;
}

export interface LoadAgentsDocumentOptions {
	readonly signal?: AbortSignal;
}

function isDocument(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAgentsYaml(source: string, sourcePath = AGENTS_FILE_NAME): AgentsDocument {
	let value: unknown;
	try {
		value = parse(source, { uniqueKeys: true });
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not parse ${sourcePath}: ${detail}`, { cause: error });
	}
	if (!isDocument(value)) throw new Error(`${sourcePath} must contain one YAML mapping.`);
	return Object.freeze(value);
}

export const parseAgentsDocument = parseAgentsYaml;

export async function loadAgentsDocument(
	sourcePath: string,
	options: LoadAgentsDocumentOptions = {},
): Promise<LoadedAgentsDocument> {
	let source: string;
	try {
		source = await readFile(sourcePath, { encoding: "utf8", signal: options.signal });
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") throw error;
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read ${sourcePath}: ${detail}`, { cause: error });
	}
	return Object.freeze({ sourcePath, document: parseAgentsYaml(source, sourcePath) });
}
