import { lstat, realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { globby } from "globby";
import type { ResolvedSectionSources } from "./source-resolution.ts";

export const DEFAULT_TREE_EXCLUDES = Object.freeze([
	".git",
	".git/**",
	"**/AGENTS.yml",
	"**/.tasks",
	"**/.tasks/**",
	"**/.pi/readcache/**",
	"**/.pi/tmp/**",
	"PRELOAD.md",
	"TREE.txt",
]);

export interface TreeFileSelectionConfiguration {
	readonly excludes: readonly string[];
}

export interface SelectedTreeFile {
	readonly absolutePath: string;
	readonly displayPath: string;
	readonly sourceRoot: string;
	readonly configurationPath: string;
}

export interface ResolveTreeFileSelectionOptions<T extends TreeFileSelectionConfiguration> {
	readonly resolution: ResolvedSectionSources<T>;
	readonly signal?: AbortSignal;
}

function normalizePattern(pattern: string): string {
	return pattern.replaceAll("\\", "/").replace(/^\.\//, "");
}

export async function resolveFileSelection<T extends TreeFileSelectionConfiguration>(
	options: ResolveTreeFileSelectionOptions<T>,
): Promise<readonly SelectedTreeFile[]> {
	const selected = new Map<string, SelectedTreeFile>();
	for (const source of options.resolution.sources) {
		options.signal?.throwIfAborted();
		if (source.section.name !== "pi-tree") {
			throw new Error(`Tree file selection does not support the ${source.section.name} section.`);
		}
		const sessionRoot = source.rootPath === options.resolution.rootPath;
		const excludes = [...DEFAULT_TREE_EXCLUDES, ...source.section.value.excludes].map(normalizePattern);
		const files = await globby("**/*", {
			absolute: true,
			cwd: source.rootPath,
			dot: true,
			followSymbolicLinks: false,
			gitignore: sessionRoot,
			ignoreFiles: sessionRoot ? undefined : "**/.gitignore",
			ignore: excludes,
			onlyFiles: true,
			unique: true,
		});
		for (const filePath of files) {
			options.signal?.throwIfAborted();
			if ((await lstat(filePath)).isSymbolicLink()) continue;
			const absolutePath = await realpath(filePath);
			if (selected.has(absolutePath)) continue;
			selected.set(
				absolutePath,
				Object.freeze({
					absolutePath,
					displayPath: relative(options.resolution.rootPath, absolutePath).split(sep).join("/"),
					sourceRoot: source.rootPath,
					configurationPath: source.sourcePath,
				}),
			);
		}
	}
	options.signal?.throwIfAborted();
	return Object.freeze(
		[...selected.values()].sort(
			(left, right) =>
				left.displayPath.localeCompare(right.displayPath) || left.absolutePath.localeCompare(right.absolutePath),
		),
	);
}
