import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { CONFIG_DIR_NAME, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DEFAULT_PRELOAD_EXCLUDES,
	DEFAULT_TREE_EXCLUDES,
	discoverAgentsSources,
	loadAgentsSection,
	parseAgentsSection,
	parseAgentsYaml,
	resolveFileSelection,
	resolvePiPreloadGraph,
	resolvePiTreeGraph,
} from "../src/index.ts";

const SelectedSectionSchema = Type.Object(
	{
		enabled: Type.Boolean(),
	},
	{ additionalProperties: false },
);

async function temporaryDirectory(t: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pi-agents-yaml-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

async function createSourceRoot(rootPath: string, packageName: string): Promise<void> {
	await mkdir(rootPath, { recursive: true });
	await Promise.all([
		writeFile(join(rootPath, "AGENTS.yml"), "selected:\n  enabled: true\n"),
		writeFile(join(rootPath, "package.json"), `${JSON.stringify({ name: packageName })}\n`),
	]);
}

test("parses one mapping and validates only the requested section", async (t) => {
	const directory = await temporaryDirectory(t);
	const sourcePath = join(directory, "AGENTS.yml");
	await writeFile(
		sourcePath,
		["other-extension:", "  arbitrary:", "    - data", "selected:", "  enabled: true", ""].join("\n"),
	);

	const loaded = await loadAgentsSection(sourcePath, "selected", SelectedSectionSchema);
	assert.deepEqual(loaded, { name: "selected", sourcePath, value: { enabled: true } });
	assert.equal(await loadAgentsSection(sourcePath, "absent", SelectedSectionSchema), undefined);

	const document = { sourcePath, document: parseAgentsYaml("selected:\n  enabled: true\n", sourcePath) };
	assert.deepEqual(parseAgentsSection(document, "selected", SelectedSectionSchema)?.value, { enabled: true });
});

test("rejects malformed YAML, duplicate keys, non-mapping roots, and invalid requested sections", async (t) => {
	const directory = await temporaryDirectory(t);
	const invalidSectionPath = join(directory, "invalid-section.yml");
	await writeFile(invalidSectionPath, "selected:\n  enabled: wrong\n");

	for (const source of ["selected: [", "selected: true\nselected: false\n", "- selected\n"]) {
		assert.throws(() => parseAgentsYaml(source, "strict-agents.yml"), /strict-agents\.yml/);
	}
	await assert.rejects(
		loadAgentsSection(invalidSectionPath, "selected", SelectedSectionSchema),
		(error: unknown) =>
			error instanceof Error && error.message.includes(invalidSectionPath) && error.message.includes("selected"),
	);
});

test("resolves pi-preload and pi-tree from only their owned sections", async (t) => {
	const directory = await temporaryDirectory(t);
	await Promise.all([
		writeFile(
			join(directory, "AGENTS.yml"),
			[
				"pi-preload:",
				"  contexts: [dioxus]",
				"  includes: [preload.txt]",
				"  signatures: [signature.ts]",
				"pi-tree:",
				"  includes: [tree.txt]",
				"",
			].join("\n"),
		),
		writeFile(join(directory, "preload.txt"), "preload"),
		writeFile(join(directory, "signature.ts"), "export const signature = true;\n"),
		writeFile(join(directory, "tree.txt"), "tree"),
	]);

	const preload = await resolvePiPreloadGraph({ rootPath: directory });
	const tree = await resolvePiTreeGraph({ rootPath: directory });
	assert.equal(preload.nodes[0]?.section.name, "pi-preload");
	assert.equal(tree.nodes[0]?.section.name, "pi-tree");
	assert.deepEqual(preload.nodes[0]?.section.value.includes, ["preload.txt"]);
	assert.deepEqual(preload.nodes[0]?.section.value.signatures, ["signature.ts"]);
	assert.deepEqual(tree.nodes[0]?.section.value.includes, ["tree.txt"]);
	assert.deepEqual(
		(await resolveFileSelection({ graph: preload })).map((file) => file.displayPath),
		["preload.txt", "signature.ts"],
	);
	assert.deepEqual(
		(await resolveFileSelection({ graph: tree })).map((file) => file.displayPath),
		["tree.txt"],
	);
});

test("applies complete preload and tree defaults without overriding explicit includes", async (t) => {
	const directory = await temporaryDirectory(t);
	const cases = [
		{
			name: "missing",
			source: "other-extension: {}\n",
			preloadIncludes: [],
			treeIncludes: ["**/*"],
		},
		{
			name: "empty",
			source: "pi-preload: {}\npi-tree: {}\n",
			preloadIncludes: [],
			treeIncludes: ["**/*"],
		},
		{
			name: "omitted-includes",
			source: "pi-preload:\n  contexts: []\npi-tree:\n  extends: []\n",
			preloadIncludes: [],
			treeIncludes: ["**/*"],
		},
		{
			name: "explicit-empty",
			source: "pi-preload:\n  includes: []\npi-tree:\n  includes: []\n",
			preloadIncludes: [],
			treeIncludes: [],
		},
		{
			name: "explicit-includes",
			source: "pi-preload:\n  includes: [preload.txt]\npi-tree:\n  includes: [tree.txt]\n",
			preloadIncludes: ["preload.txt"],
			treeIncludes: ["tree.txt"],
		},
	] as const;

	for (const selectedCase of cases) {
		const root = join(directory, selectedCase.name);
		await mkdir(root);
		await writeFile(join(root, "AGENTS.yml"), selectedCase.source);
		const preload = await resolvePiPreloadGraph({ rootPath: root });
		const tree = await resolvePiTreeGraph({ rootPath: root });
		assert.deepEqual(preload.nodes[0]?.section.value, {
			contexts: [],
			excludes: [],
			extends: [],
			includes: [...selectedCase.preloadIncludes],
			presets: [],
			signatures: [],
		});
		assert.deepEqual(tree.nodes[0]?.section.value, {
			excludes: [],
			extends: [],
			includes: [...selectedCase.treeIncludes],
		});
	}
});

test("uses exact package excludes before configured excludes", async (t) => {
	assert.deepEqual(DEFAULT_PRELOAD_EXCLUDES, [
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
	assert.deepEqual(DEFAULT_TREE_EXCLUDES, [
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

	const directory = await temporaryDirectory(t);
	await Promise.all([
		mkdir(join(directory, ".tasks")),
		mkdir(join(directory, "nested", ".tasks"), { recursive: true }),
	]);
	await Promise.all([
		writeFile(
			join(directory, "AGENTS.yml"),
			"pi-preload:\n  includes: ['**/*']\n  excludes: [blocked.txt]\npi-tree:\n  includes: ['**/*']\n  excludes: [blocked.txt]\n",
		),
		writeFile(join(directory, "visible.txt"), "visible"),
		writeFile(join(directory, "blocked.txt"), "blocked"),
		writeFile(join(directory, "package-lock.json"), "{}\n"),
		writeFile(join(directory, "PRELOAD.md"), "generated"),
		writeFile(join(directory, "TREE.txt"), "generated"),
		writeFile(join(directory, ".tasks", "plan.md"), "task"),
		writeFile(join(directory, "nested", "AGENTS.yml"), "pi-tree: {}\n"),
		writeFile(join(directory, "nested", ".tasks", "plan.md"), "nested task"),
	]);

	const preload = await resolveFileSelection({ graph: await resolvePiPreloadGraph({ rootPath: directory }) });
	const tree = await resolveFileSelection({ graph: await resolvePiTreeGraph({ rootPath: directory }) });
	assert.deepEqual(preload.map((file) => file.displayPath), ["visible.txt"]);
	assert.deepEqual(tree.map((file) => file.displayPath), ["package-lock.json", "visible.txt"]);
});

test("preserves cancellation for document loading", async (t) => {
	const directory = await temporaryDirectory(t);
	const sourcePath = join(directory, "AGENTS.yml");
	await writeFile(sourcePath, "selected:\n  enabled: true\n");
	const controller = new AbortController();
	controller.abort();

	await assert.rejects(
		loadAgentsSection(sourcePath, "selected", SelectedSectionSchema, { signal: controller.signal }),
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
	await assert.rejects(
		resolvePiPreloadGraph({ rootPath: directory, signal: controller.signal }),
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
});

test("discovers ordered physical sources without reading an untrusted project", async (t) => {
	const directory = await temporaryDirectory(t);
	const agentDirectory = join(directory, "agent");
	const projectRoot = join(directory, "project");
	const projectConfigurationDirectory = join(projectRoot, CONFIG_DIR_NAME);
	const ownedRoot = join(directory, "owned");
	const userRoot = join(directory, "user");
	const userAlias = join(directory, "user-alias");
	const projectPackageRoot = join(directory, "project-package");
	const currentProjectMirror = join(directory, "current-project-mirror");
	await Promise.all([
		mkdir(agentDirectory),
		mkdir(projectConfigurationDirectory, { recursive: true }),
		createSourceRoot(ownedRoot, "pi-owner"),
		createSourceRoot(userRoot, "pi-user-source"),
		createSourceRoot(projectPackageRoot, "pi-project-source"),
		createSourceRoot(currentProjectMirror, "pi-current-project"),
	]);
	await Promise.all([
		writeFile(join(projectRoot, "package.json"), '{"name":"pi-current-project"}\n'),
		symlink(userRoot, userAlias, "dir"),
	]);
	const settingsManager = SettingsManager.create(projectRoot, agentDirectory);
	settingsManager.setPackages([userRoot]);
	await settingsManager.flush();
	await writeFile(join(projectConfigurationDirectory, "settings.json"), "not json");

	const untrusted = discoverAgentsSources({
		cwd: projectRoot,
		projectTrusted: false,
		packageRoot: ownedRoot,
		agentDirectory,
	});
	assert.deepEqual(
		untrusted.map(({ rootPath, scope }) => ({ rootPath, scope })),
		[
			{ rootPath: await realpath(ownedRoot), scope: "owned" },
			{ rootPath: await realpath(userRoot), scope: "user" },
		],
	);

	await writeFile(
		join(projectConfigurationDirectory, "settings.json"),
		`${JSON.stringify({ packages: [userAlias, projectPackageRoot, currentProjectMirror] })}\n`,
	);
	const trusted = discoverAgentsSources({
		cwd: projectRoot,
		projectTrusted: true,
		packageRoot: ownedRoot,
		agentDirectory,
	});
	assert.deepEqual(
		trusted.map(({ rootPath, scope, origin }) => ({ rootPath, scope, origin })),
		[
			{ rootPath: await realpath(ownedRoot), scope: "owned", origin: "package" },
			{ rootPath: await realpath(userRoot), scope: "user", origin: "package" },
			{ rootPath: await realpath(projectPackageRoot), scope: "project", origin: "package" },
			{ rootPath: await realpath(projectRoot), scope: "project", origin: "project" },
		],
	);
	const currentProjectMirrorPath = await realpath(currentProjectMirror);
	assert.equal(
		trusted.some(({ rootPath }) => rootPath === currentProjectMirrorPath),
		false,
	);
	assert.equal(trusted.at(-1)?.hasAgentsFile, false);
});

test("cancels source discovery before settings or project sources are read", () => {
	const controller = new AbortController();
	controller.abort();
	assert.throws(
		() =>
			discoverAgentsSources({
				cwd: "/unread-project",
				projectTrusted: false,
				agentDirectory: "/unread-agent",
				signal: controller.signal,
			}),
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
});

test("resolves preload presets and extended roots in stable order", async (t) => {
	const directory = await temporaryDirectory(t);
	const root = join(directory, "root");
	const child = join(root, "child");
	const childAlias = join(root, "child-alias");
	const presetDirectory = join(directory, "presets");
	await Promise.all([mkdir(child, { recursive: true }), mkdir(presetDirectory)]);
	await Promise.all([
		writeFile(
			join(root, "AGENTS.yml"),
			[
				"pi-preload:",
				"  presets: [base, extra, dioxus-rust]",
				"  extends: [./child, ./child-alias]",
				"  contexts: [root-local]",
				"  includes: ['*.txt']",
				"  excludes: [root-only.txt]",
				"",
			].join("\n"),
		),
		writeFile(
			join(child, "AGENTS.yml"),
			"pi-preload:\n  presets: [dioxus-rust]\n  contexts: [child-context]\n  includes: ['*.txt']\n",
		),
		writeFile(
			join(presetDirectory, "base.yml"),
			"contexts: [base-context]\nincludes: [base/*.txt]\nexcludes: [base-ignore.txt]\n",
		),
		writeFile(
			join(presetDirectory, "extra.yml"),
			"contexts: [extra-context, base-context]\nincludes: [extra/*.txt]\nexcludes: [extra-ignore.txt]\n",
		),
		symlink(child, childAlias, "dir"),
	]);

	const graph = await resolvePiPreloadGraph({ rootPath: root, presetDirectory });
	assert.deepEqual(
		graph.nodes.map(({ rootPath }) => rootPath),
		[await realpath(child), await realpath(root)],
	);
	const rootConfiguration = graph.nodes.at(-1)?.section?.value;
	assert.deepEqual(rootConfiguration?.contexts, ["base-context", "extra-context", "dioxus", "root-local"]);
	assert.deepEqual(rootConfiguration?.includes, ["base/*.txt", "extra/*.txt", "*.txt"]);
	assert.deepEqual(rootConfiguration?.excludes, ["base-ignore.txt", "extra-ignore.txt", "root-only.txt"]);
	assert.deepEqual(
		graph.nodes.flatMap((node) =>
			(node.section?.value.contexts ?? []).map((context) => ({ context, rootPath: node.rootPath })),
		),
		[
			{ context: "dioxus", rootPath: await realpath(child) },
			{ context: "child-context", rootPath: await realpath(child) },
			{ context: "base-context", rootPath: await realpath(root) },
			{ context: "extra-context", rootPath: await realpath(root) },
			{ context: "dioxus", rootPath: await realpath(root) },
			{ context: "root-local", rootPath: await realpath(root) },
		],
	);
});

test("keeps explicit targets that lack the requested section and applies only owned defaults", async (t) => {
	const directory = await temporaryDirectory(t);
	const preloadTarget = join(directory, "preload-target");
	const treeTarget = join(directory, "tree-target");
	await Promise.all([mkdir(preloadTarget), mkdir(treeTarget)]);
	await Promise.all([
		writeFile(
			join(directory, "AGENTS.yml"),
			"pi-preload:\n  extends: [./preload-target]\npi-tree:\n  extends: [./tree-target]\n  includes: []\n",
		),
		writeFile(join(preloadTarget, "AGENTS.yml"), "pi-tree:\n  includes: [tree-only.txt]\n"),
		writeFile(join(treeTarget, "AGENTS.yml"), "pi-preload:\n  includes: [preload-only.txt]\n"),
	]);

	const preload = await resolvePiPreloadGraph({ rootPath: directory });
	const tree = await resolvePiTreeGraph({ rootPath: directory });
	assert.deepEqual(
		preload.nodes.map((node) => ({ rootPath: node.rootPath, name: node.section.name, value: node.section.value })),
		[
			{
				rootPath: await realpath(preloadTarget),
				name: "pi-preload",
				value: { contexts: [], excludes: [], extends: [], includes: [], presets: [], signatures: [] },
			},
			{
				rootPath: await realpath(directory),
				name: "pi-preload",
				value: {
					contexts: [],
					excludes: [],
					extends: ["./preload-target"],
					includes: [],
					presets: [],
					signatures: [],
				},
			},
		],
	);
	assert.deepEqual(
		tree.nodes.map((node) => ({ rootPath: node.rootPath, name: node.section.name, value: node.section.value })),
		[
			{
				rootPath: await realpath(treeTarget),
				name: "pi-tree",
				value: { excludes: [], extends: [], includes: ["**/*"] },
			},
			{
				rootPath: await realpath(directory),
				name: "pi-tree",
				value: { excludes: [], extends: ["./tree-target"], includes: [] },
			},
		],
	);
});

test("selects explicit full and signature files across an ignored meta repository", async (t) => {
	const directory = await temporaryDirectory(t);
	const root = join(directory, "meta");
	const child = join(root, "packages", "tool");
	const nested = join(child, "nested");
	const childAlias = join(root, "tool-alias");
	await Promise.all([
		mkdir(join(root, ".git"), { recursive: true }),
		mkdir(join(child, "src"), { recursive: true }),
		mkdir(join(child, "types"), { recursive: true }),
		mkdir(nested, { recursive: true }),
	]);
	await Promise.all([
		writeFile(
			join(root, "AGENTS.yml"),
			[
				"pi-preload:",
				"  extends: [./packages/tool, ./tool-alias]",
				"  includes: [root-full.txt]",
				"  signatures: ['**/*.ts']",
				"",
			].join("\n"),
		),
		writeFile(
			join(child, "AGENTS.yml"),
			[
				"pi-preload:",
				"  extends: [./nested]",
				"  includes: [src/**/*.ts]",
				"  signatures: [src/**/*.ts, types/**/*.ts]",
				"  excludes: [src/excluded.ts]",
				"",
			].join("\n"),
		),
		writeFile(
			join(nested, "AGENTS.yml"),
			"pi-preload:\n  includes: [full.txt]\n  signatures: ['*.ts']\n  excludes: [excluded.ts]\n",
		),
		writeFile(join(root, ".gitignore"), "packages/\ntool-alias/\n"),
		writeFile(join(root, "root-full.txt"), "root full"),
		writeFile(join(root, "root-signature.ts"), "export {};\n"),
		writeFile(join(root, "sentinel.md"), "unselected"),
		writeFile(join(child, "src", "full.ts"), "export {};\n"),
		writeFile(join(child, "src", "excluded.ts"), "export {};\n"),
		writeFile(join(child, "types", "signature.ts"), "export {};\n"),
		writeFile(join(child, "sentinel.md"), "unselected"),
		writeFile(join(nested, "full.txt"), "nested full"),
		writeFile(join(nested, "signature.ts"), "export {};\n"),
		writeFile(join(nested, "excluded.ts"), "export {};\n"),
		writeFile(join(nested, "sentinel.md"), "unselected"),
		symlink(child, childAlias, "dir"),
	]);
	await symlink(join(child, "src", "full.ts"), join(child, "types", "linked.ts"));

	const graph = await resolvePiPreloadGraph({ rootPath: root });
	const selected = await resolveFileSelection({ graph });
	assert.equal(new Set(selected.map(({ absolutePath }) => absolutePath)).size, selected.length);
	assert.equal(Object.isFrozen(selected), true);
	assert.equal(selected.every(Object.isFrozen), true);
	assert.deepEqual(
		selected.map(({ displayPath, mode, sourceRoot, configurationPath }) => ({
			displayPath,
			mode,
			sourceRoot,
			configurationPath,
		})),
		[
			{
				displayPath: "packages/tool/nested/full.txt",
				mode: "full",
				sourceRoot: await realpath(nested),
				configurationPath: join(await realpath(nested), "AGENTS.yml"),
			},
			{
				displayPath: "packages/tool/nested/signature.ts",
				mode: "signature",
				sourceRoot: await realpath(nested),
				configurationPath: join(await realpath(nested), "AGENTS.yml"),
			},
			{
				displayPath: "packages/tool/src/full.ts",
				mode: "full",
				sourceRoot: await realpath(child),
				configurationPath: join(await realpath(child), "AGENTS.yml"),
			},
			{
				displayPath: "packages/tool/types/signature.ts",
				mode: "signature",
				sourceRoot: await realpath(child),
				configurationPath: join(await realpath(child), "AGENTS.yml"),
			},
			{
				displayPath: "root-full.txt",
				mode: "full",
				sourceRoot: await realpath(root),
				configurationPath: join(await realpath(root), "AGENTS.yml"),
			},
			{
				displayPath: "root-signature.ts",
				mode: "signature",
				sourceRoot: await realpath(root),
				configurationPath: join(await realpath(root), "AGENTS.yml"),
			},
		],
	);
});

test("rejects canonical extends cycles with the declaring source path", async (t) => {
	const directory = await temporaryDirectory(t);
	const root = join(directory, "root");
	const child = join(root, "child");
	await mkdir(child, { recursive: true });
	await Promise.all([
		writeFile(join(root, "AGENTS.yml"), "pi-preload:\n  extends: [./child]\n"),
		writeFile(join(child, "AGENTS.yml"), "pi-preload:\n  extends: [..]\n"),
	]);
	const childSourcePath = join(await realpath(child), "AGENTS.yml");
	await assert.rejects(
		resolvePiPreloadGraph({ rootPath: root }),
		(error: unknown) => error instanceof Error && error.message.includes(childSourcePath),
	);
});
