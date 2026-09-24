import { lstat, realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { globby } from "globby";
import type { ResolvedSectionSources } from "./source-resolution.ts";

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
	"**/dist",
	"**/dist/**",
	"**/node_modules",
	"**/node_modules/**",
	"PRELOAD.md",
	"TREE.txt",
]);

export type PreloadFileSelectionMode = "full" | "signature";

export interface PreloadFileSelectionConfiguration {
	readonly excludes: readonly string[];
	readonly includes: readonly string[];
	readonly signatures: readonly string[];
}

export interface SelectedPreloadFile extends SelectedTreeFile {
	readonly mode: PreloadFileSelectionMode;
}

export interface ResolvePreloadFileSelectionOptions<T extends PreloadFileSelectionConfiguration> {
	readonly resolution: ResolvedSectionSources<T>;
	readonly signal?: AbortSignal;
}

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

export async function resolvePreloadFileSelection<T extends PreloadFileSelectionConfiguration>(
	options: ResolvePreloadFileSelectionOptions<T>,
): Promise<readonly SelectedPreloadFile[]> {
	const selected = new Map<string, SelectedPreloadFile>();
	for (const source of options.resolution.sources) {
		options.signal?.throwIfAborted();
		if (source.section.name !== "pi-preload") {
			throw new Error(`Preload file selection does not support the ${source.section.name} section.`);
		}
		const configuration = source.section.value;
		const excludes = [...DEFAULT_PRELOAD_EXCLUDES, ...configuration.excludes].map(normalizePattern);
		for (const [mode, patterns] of [
			["signature", configuration.signatures],
			["full", configuration.includes],
		] as const) {
			if (patterns.length === 0) continue;
			const files = await globby(patterns.map(normalizePattern), {
				absolute: true,
				cwd: source.rootPath,
				dot: true,
				followSymbolicLinks: false,
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
						displayPath: relative(options.resolution.rootPath, absolutePath).split(sep).join("/"),
						sourceRoot: source.rootPath,
						configurationPath: source.sourcePath,
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
