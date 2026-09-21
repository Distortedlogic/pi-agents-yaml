import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { type LoadAgentsDocumentOptions, type LoadedAgentsDocument, loadAgentsDocument } from "./document.ts";

export interface LoadedAgentsSection<T> {
	readonly name: string;
	readonly sourcePath: string;
	readonly value: T;
}

export function parseAgentsSection<TSchemaType extends TSchema>(
	loaded: LoadedAgentsDocument,
	name: string,
	schema: TSchemaType,
): LoadedAgentsSection<Static<TSchemaType>> | undefined {
	const value = loaded.document[name];
	if (value === undefined) return undefined;
	try {
		return Object.freeze({
			name,
			sourcePath: loaded.sourcePath,
			value: Value.Parse(schema, value),
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid configuration in ${loaded.sourcePath} at ${name}: ${detail}`, { cause: error });
	}
}

export async function loadAgentsSection<TSchemaType extends TSchema>(
	sourcePath: string,
	name: string,
	schema: TSchemaType,
	options: LoadAgentsDocumentOptions = {},
): Promise<LoadedAgentsSection<Static<TSchemaType>> | undefined> {
	let loaded: LoadedAgentsDocument;
	try {
		loaded = await loadAgentsDocument(sourcePath, options);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") throw error;
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not load section ${name} from ${sourcePath}: ${detail}`, { cause: error });
	}
	return parseAgentsSection(loaded, name, schema);
}
