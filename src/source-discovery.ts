import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME, DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AGENTS_FILE_NAME } from "./document.ts";

export type AgentsSourceScope = "owned" | "user" | "project";
export type AgentsSourceOrigin = "package" | "project";

export interface AgentsSourceRoot {
	readonly rootPath: string;
	readonly sourcePath: string;
	readonly scope: AgentsSourceScope;
	readonly origin: AgentsSourceOrigin;
}

export interface DiscoverAgentsSourceRootsOptions {
	readonly cwd: string;
	readonly projectTrusted: boolean;
	readonly packageRoot?: string;
	readonly agentDirectory?: string;
	readonly signal?: AbortSignal;
}

export type DiscoverAgentsSourcesOptions = DiscoverAgentsSourceRootsOptions;

function packageName(rootPath: string): string | undefined {
	try {
		const manifest = JSON.parse(readFileSync(join(rootPath, "package.json"), "utf8")) as { name?: unknown };
		return typeof manifest.name === "string" ? manifest.name : undefined;
	} catch {
		return undefined;
	}
}

function physicalRoot(rootPath: string): string {
	const root = resolve(rootPath);
	try {
		return realpathSync.native(root);
	} catch {
		return root;
	}
}

function source(rootPath: string, scope: AgentsSourceScope, origin: AgentsSourceOrigin): AgentsSourceRoot | undefined {
	const unresolvedRoot = resolve(rootPath);
	if (!existsSync(join(unresolvedRoot, AGENTS_FILE_NAME))) return undefined;
	const root = physicalRoot(unresolvedRoot);
	return Object.freeze({ rootPath: root, sourcePath: join(root, AGENTS_FILE_NAME), scope, origin });
}

export function discoverAgentsSources(options: DiscoverAgentsSourceRootsOptions): readonly AgentsSourceRoot[] {
	options.signal?.throwIfAborted();
	const cwd = resolve(options.cwd);
	const agentDirectory = resolve(options.agentDirectory ?? join(homedir(), CONFIG_DIR_NAME, "agent"));
	const settingsCwd = options.projectTrusted ? cwd : agentDirectory;
	const settingsManager = SettingsManager.create(settingsCwd, agentDirectory);
	const packageManager = new DefaultPackageManager({ cwd: settingsCwd, agentDir: agentDirectory, settingsManager });
	const configuredPackages = packageManager.listConfiguredPackages();
	const projectRoot = options.projectTrusted ? physicalRoot(cwd) : undefined;
	const projectPackageName = options.projectTrusted ? packageName(cwd) : undefined;
	const isProjectPackage = (rootPath: string): boolean =>
		options.projectTrusted &&
		(physicalRoot(rootPath) === projectRoot ||
			(projectPackageName !== undefined && packageName(rootPath) === projectPackageName));
	const roots: AgentsSourceRoot[] = [];
	const add = (candidate: AgentsSourceRoot | undefined): void => {
		if (!candidate || roots.some((existing) => existing.rootPath === candidate.rootPath)) return;
		roots.push(candidate);
	};

	if (options.packageRoot && !isProjectPackage(options.packageRoot)) {
		add(source(options.packageRoot, "owned", "package"));
	}
	for (const configured of configuredPackages) {
		options.signal?.throwIfAborted();
		if (!configured.installedPath || configured.scope !== "user" || isProjectPackage(configured.installedPath))
			continue;
		add(source(configured.installedPath, "user", "package"));
	}
	if (options.projectTrusted) {
		for (const configured of configuredPackages) {
			options.signal?.throwIfAborted();
			if (!configured.installedPath || configured.scope !== "project" || isProjectPackage(configured.installedPath)) {
				continue;
			}
			add(source(configured.installedPath, "project", "package"));
		}
		add(source(cwd, "project", "project"));
	}
	options.signal?.throwIfAborted();
	return Object.freeze(roots);
}

export const discoverAgentsSourceRoots = discoverAgentsSources;
