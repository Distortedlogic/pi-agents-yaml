import { lstat, realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { globby } from "globby";
import type { ResolvedSectionGraph } from "./graph-resolution.ts";

export const DEFAULT_PRELOAD_EXCLUDES = Object.freeze([
	".git",
	".git/**",
	"**/AGENTS.yml",
	"**/.tasks",
	"**/.tasks/**",
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

export const DEFAULT_FILE_EXCLUDES = DEFAULT_PRELOAD_EXCLUDES;

export type FileSelectionMode = "full" | "signature";

export interface FileSelectionConfiguration {
	readonly excludes: readonly string[];
	readonly explicitIncludes?: boolean;
	readonly includes: readonly string[];
	readonly signatures?: readonly string[];
}

export interface SelectedAgentsFile {
	readonly absolutePath: string;
	readonly displayPath: string;
	readonly sourceRoot: string;
	readonly configurationPath: string;
	readonly mode: FileSelectionMode;
}

export interface ResolveFileSelectionOptions<T extends FileSelectionConfiguration> {
	readonly graph: ResolvedSectionGraph<T>;
	readonly signal?: AbortSignal;
}

function normalizePattern(pattern: string): string {
	return pattern.replaceAll("\\", "/").replace(/^\.\//, "");
}

function packageExcludes(sectionName: string): readonly string[] {
	if (sectionName === "pi-preload") return DEFAULT_PRELOAD_EXCLUDES;
	if (sectionName === "pi-tree") return DEFAULT_TREE_EXCLUDES;
	throw new Error(`File selection does not support the ${sectionName} section.`);
}

export async function resolveFileSelection<T extends FileSelectionConfiguration>(
	options: ResolveFileSelectionOptions<T>,
): Promise<readonly SelectedAgentsFile[]> {
	const selected = new Map<string, SelectedAgentsFile>();
	for (const node of options.graph.nodes) {
		options.signal?.throwIfAborted();
		const configuration = node.section.value;
		const sessionRoot = node.rootPath === options.graph.rootPath;
		const excludes = [...packageExcludes(node.section.name), ...configuration.excludes].map(normalizePattern);
		for (const [mode, patterns] of [
			["signature", configuration.signatures ?? []],
			["full", configuration.includes],
		] as const) {
			if (patterns.length === 0) continue;
			const useGitignore = mode === "full" && configuration.explicitIncludes !== true;
			const files = await globby(patterns.map(normalizePattern), {
				absolute: true,
				cwd: node.rootPath,
				dot: true,
				followSymbolicLinks: false,
				gitignore: useGitignore && sessionRoot,
				ignoreFiles: useGitignore && !sessionRoot ? "**/.gitignore" : undefined,
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
