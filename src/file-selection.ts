import { lstat, realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { globby } from "globby";
import type { ResolvedAgentsGraph } from "./graph-resolution.ts";

export const DEFAULT_PRELOAD_EXCLUDES = Object.freeze([
	".git",
	".git/**",
	"PRELOAD.md",
	"TREE.txt",
	"**/.terraform.lock.hcl",
	"**/bun.lock",
	"**/bun.lockb",
	"**/Cargo.lock",
	"**/composer.lock",
	"**/deno.lock",
	"**/flake.lock",
	"**/Gemfile.lock",
	"**/gradle.lockfile",
	"**/mix.lock",
	"**/npm-shrinkwrap.json",
	"**/package-lock.json",
	"**/Package.resolved",
	"**/packages.lock.json",
	"**/paket.lock",
	"**/Pipfile.lock",
	"**/pnpm-lock.yaml",
	"**/Podfile.lock",
	"**/poetry.lock",
	"**/pubspec.lock",
	"**/uv.lock",
	"**/yarn.lock",
]);

export const DEFAULT_FILE_EXCLUDES = DEFAULT_PRELOAD_EXCLUDES;

export type FileSelectionMode = "full" | "signature";

export interface FileSelectionConfiguration {
	readonly includes?: readonly string[];
	readonly signatures?: readonly string[];
	readonly excludes?: readonly string[];
}

export interface SelectedAgentsFile {
	readonly absolutePath: string;
	readonly displayPath: string;
	readonly sourceRoot: string;
	readonly configurationPath: string;
	readonly mode: FileSelectionMode;
}

export interface ResolveFileSelectionOptions<T extends FileSelectionConfiguration> {
	readonly graph: ResolvedAgentsGraph<T>;
	readonly excludes?: readonly string[];
	readonly signal?: AbortSignal;
}

function normalizePattern(pattern: string): string {
	return pattern.replaceAll("\\", "/").replace(/^\.\//, "");
}

export async function resolveFileSelection<T extends FileSelectionConfiguration>(
	options: ResolveFileSelectionOptions<T>,
): Promise<readonly SelectedAgentsFile[]> {
	const selected = new Map<string, SelectedAgentsFile>();
	for (const node of options.graph.nodes) {
		options.signal?.throwIfAborted();
		const configuration = node.section?.value;
		if (!configuration) continue;
		const sessionRoot = node.rootPath === options.graph.rootPath;
		const excludes = [...DEFAULT_PRELOAD_EXCLUDES, ...(options.excludes ?? []), ...(configuration.excludes ?? [])].map(
			normalizePattern,
		);
		for (const [mode, patterns] of [
			["signature", configuration.signatures ?? []],
			["full", configuration.includes ?? []],
		] as const) {
			if (patterns.length === 0) continue;
			const files = await globby(patterns.map(normalizePattern), {
				absolute: true,
				cwd: node.rootPath,
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
				const existing = selected.get(absolutePath);
				if (existing?.mode === "full" || (existing && mode === "signature")) continue;
				selected.set(
					absolutePath,
					Object.freeze({
						absolutePath,
						displayPath: relative(options.graph.rootPath, absolutePath).split(sep).join("/"),
						sourceRoot: node.rootPath,
						configurationPath: node.sourcePath,
						mode,
					}),
				);
			}
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
