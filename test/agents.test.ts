import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { CONFIG_DIR_NAME, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	AgentsConfigurationSchema,
	DEFAULT_TREE_EXCLUDES,
	discoverAgentsSources,
	loadAgentsSection,
	MAX_AGENTS_EXTENDS_DEPTH,
	parseAgentsSection,
	parseAgentsYaml,
	resolveFileSelection,
	resolvePiPreloadSources,
	resolvePiTreeSources,
	resolvePreloadFileSelection,
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
			["pi-preload:", "  contexts: [dioxus]", "pi-tree:", "  excludes: [excluded.txt]", ""].join("\n"),
		),
		writeFile(join(directory, "visible.txt"), "visible"),
		writeFile(join(directory, "excluded.txt"), "excluded"),
	]);

	const preload = await resolvePiPreloadSources({ rootPath: directory });
	const tree = await resolvePiTreeSources({ rootPath: directory });
	assert.equal(preload.sources[0]?.section.name, "pi-preload");
	assert.equal(tree.sources[0]?.section.name, "pi-tree");
	assert.deepEqual(preload.sources[0]?.section.value.contexts, ["dioxus"]);
	assert.deepEqual(tree.sources[0]?.section.value.excludes, ["excluded.txt"]);
	assert.deepEqual(
		(await resolveFileSelection({ resolution: tree })).map((file) => file.displayPath),
		["visible.txt"],
	);
});

test("applies complete context and tree defaults", async (t) => {
	const directory = await temporaryDirectory(t);
	const cases = [
		{ name: "missing", source: "other-extension: {}\n", contexts: [], excludes: [] },
		{ name: "empty", source: "pi-preload: {}\npi-tree: {}\n", contexts: [], excludes: [] },
		{
			name: "configured",
			source: "pi-preload:\n  contexts: [dioxus]\npi-tree:\n  excludes: [generated/**]\n",
			contexts: ["dioxus"],
			excludes: ["generated/**"],
		},
	] as const;

	for (const selectedCase of cases) {
		const root = join(directory, selectedCase.name);
		await mkdir(root);
		await writeFile(join(root, "AGENTS.yml"), selectedCase.source);
		const preload = await resolvePiPreloadSources({ rootPath: root });
		const tree = await resolvePiTreeSources({ rootPath: root });
		assert.deepEqual(preload.sources[0]?.section.value, {
			contexts: [...selectedCase.contexts],
			excludes: [],
			extends: [],
			includes: [],
			presets: [],
			signatures: [],
		});
		assert.deepEqual(tree.sources[0]?.section.value, {
			excludes: [...selectedCase.excludes],
			extends: [],
		});
	}
});

test("selects the full Git-visible tree before configured excludes", async (t) => {
	for (const path of ["**/.tasks/**", "**/dist/**", "**/node_modules/**", "PRELOAD.md"]) {
		assert.equal(DEFAULT_TREE_EXCLUDES.includes(path), true);
	}
	assert.equal(DEFAULT_TREE_EXCLUDES.includes("**/package-lock.json"), false);

	const directory = await temporaryDirectory(t);
	await Promise.all([
		mkdir(join(directory, ".tasks")),
		mkdir(join(directory, "ignored")),
		mkdir(join(directory, "dist")),
		mkdir(join(directory, "node_modules", "package"), { recursive: true }),
		mkdir(join(directory, "nested", ".tasks"), { recursive: true }),
	]);
	await Promise.all([
		writeFile(join(directory, "AGENTS.yml"), "pi-tree:\n  excludes: [.gitignore, blocked.txt, ignored/excluded.txt]\n"),
		writeFile(join(directory, ".gitignore"), "ignored/\n"),
		writeFile(join(directory, "visible.txt"), "visible"),
		writeFile(join(directory, "blocked.txt"), "blocked"),
		writeFile(join(directory, "ignored", "excluded.txt"), "excluded"),
		writeFile(join(directory, "ignored", "selected.txt"), "selected"),
		writeFile(join(directory, "dist", "generated.js"), "generated"),
		writeFile(join(directory, "node_modules", "package", "index.js"), "dependency"),
		writeFile(join(directory, "package-lock.json"), "{}\n"),
		writeFile(join(directory, "PRELOAD.md"), "generated"),
		writeFile(join(directory, "TREE.txt"), "generated"),
		writeFile(join(directory, ".tasks", "plan.md"), "task"),
		writeFile(join(directory, "nested", "AGENTS.yml"), "pi-tree: {}\n"),
		writeFile(join(directory, "nested", ".tasks", "plan.md"), "nested task"),
	]);

	const tree = await resolveFileSelection({ resolution: await resolvePiTreeSources({ rootPath: directory }) });
	assert.deepEqual(
		tree.map((file) => file.displayPath),
		["package-lock.json", "visible.txt"],
	);

	await writeFile(join(directory, "AGENTS.yml"), "pi-tree: {}\n");
	const defaultTree = await resolveFileSelection({
		resolution: await resolvePiTreeSources({ rootPath: directory }),
	});
	assert.deepEqual(
		defaultTree.map((file) => file.displayPath),
		[".gitignore", "blocked.txt", "package-lock.json", "visible.txt"],
	);
});

test("keeps the generated AGENTS schema aligned with owned section contracts", async () => {
	const generated = JSON.parse(
		await readFile(new URL("../schemas/AGENTS.schema.json", import.meta.url), "utf8"),
	) as Record<string, unknown>;
	const { $schema, ...documentSchema } = generated;
	assert.equal($schema, "https://json-schema.org/draft/2020-12/schema");
	assert.deepEqual(documentSchema, JSON.parse(JSON.stringify(AgentsConfigurationSchema)));
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
				"",
			].join("\n"),
		),
		writeFile(join(child, "AGENTS.yml"), "pi-preload:\n  presets: [dioxus-rust]\n  contexts: [child-context]\n"),
		writeFile(
			join(presetDirectory, "base.yml"),
			"contexts: [base-context]\nincludes: [base/*.txt]\nexcludes: [base-ignore.txt]\n",
		),
		writeFile(
			join(presetDirectory, "extra.yml"),
			"contexts: [extra-context, base-context]\nsignatures: [extra/*.ts]\nexcludes: [extra-ignore.txt]\n",
		),
		symlink(child, childAlias, "dir"),
	]);

	const resolution = await resolvePiPreloadSources({ rootPath: root, presetDirectory });
	assert.deepEqual(
		resolution.sources.map(({ rootPath }) => rootPath),
		[await realpath(child), await realpath(root)],
	);
	const rootConfiguration = resolution.sources.at(-1)?.section?.value;
	assert.deepEqual(rootConfiguration?.contexts, ["base-context", "extra-context", "dioxus", "root-local"]);
	assert.deepEqual(rootConfiguration?.includes, ["base/*.txt"]);
	assert.deepEqual(rootConfiguration?.signatures, ["extra/*.ts"]);
	assert.deepEqual(rootConfiguration?.excludes, ["base-ignore.txt", "extra-ignore.txt"]);
	assert.deepEqual(
		resolution.sources.flatMap((source) =>
			(source.section?.value.contexts ?? []).map((context) => ({ context, rootPath: source.rootPath })),
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

test("rejects preload file-selection fields in public AGENTS.yml", async (t) => {
	const directory = await temporaryDirectory(t);
	for (const field of ["includes", "excludes", "signatures"] as const) {
		await writeFile(join(directory, "AGENTS.yml"), `pi-preload:\n  ${field}: ['**/*']\n`);
		await assert.rejects(resolvePiPreloadSources({ rootPath: directory }), /Invalid configuration.*pi-preload/);
	}
});

test("selects full and signature files from presets only", async (t) => {
	const directory = await temporaryDirectory(t);
	const presetDirectory = join(directory, "presets");
	await mkdir(presetDirectory);
	await Promise.all([
		writeFile(
			join(presetDirectory, "files.yml"),
			"includes: [full.ts]\nsignatures: ['*.ts']\nexcludes: [excluded.ts]\n",
		),
		writeFile(join(directory, "full.ts"), "export function full() { return true; }\n"),
		writeFile(join(directory, "signature.ts"), "export function signature() { return true; }\n"),
		writeFile(join(directory, "excluded.ts"), "export function excluded() { return true; }\n"),
	]);

	const resolution = await resolvePiPreloadSources({
		rootPath: directory,
		rootValue: { presets: ["files"] },
		presetDirectory,
	});
	assert.deepEqual(
		(await resolvePreloadFileSelection({ resolution })).map(({ displayPath, mode }) => ({ displayPath, mode })),
		[
			{ displayPath: "full.ts", mode: "full" },
			{ displayPath: "signature.ts", mode: "signature" },
		],
	);
});

test("pi-extension preset provides native documentation and critical public signatures", async (t) => {
	const directory = await temporaryDirectory(t);
	const resolution = await resolvePiPreloadSources({
		rootPath: directory,
		rootValue: { presets: ["pi-extension"] },
	});
	const configuration = resolution.sources[0]?.section.value;
	assert.ok(configuration);
	for (const document of ["extensions", "packages", "prompt-templates", "settings", "skills", "themes"]) {
		assert.equal(
			configuration.includes.some((pattern) => pattern.includes(document)),
			true,
			document,
		);
	}
	assert.deepEqual(configuration.signatures, [
		"/home/entropybender/coding/3rd/pi/packages/coding-agent/src/index.ts",
		"/home/entropybender/coding/3rd/pi/packages/coding-agent/src/core/extensions/types.ts",
	]);
});

test("keeps explicit targets that lack the requested section and applies only owned defaults", async (t) => {
	const directory = await temporaryDirectory(t);
	const preloadTarget = join(directory, "preload-target");
	const treeTarget = join(directory, "tree-target");
	await Promise.all([mkdir(preloadTarget), mkdir(treeTarget)]);
	await Promise.all([
		writeFile(
			join(directory, "AGENTS.yml"),
			"pi-preload:\n  extends: [./preload-target]\npi-tree:\n  extends: [./tree-target]\n",
		),
		writeFile(join(preloadTarget, "AGENTS.yml"), "pi-tree: {}\n"),
		writeFile(join(treeTarget, "AGENTS.yml"), "pi-preload:\n  contexts: [dioxus]\n"),
	]);

	const preload = await resolvePiPreloadSources({ rootPath: directory });
	const tree = await resolvePiTreeSources({ rootPath: directory });
	assert.deepEqual(
		preload.sources.map((source) => ({
			rootPath: source.rootPath,
			name: source.section.name,
			value: source.section.value,
		})),
		[
			{
				rootPath: await realpath(preloadTarget),
				name: "pi-preload",
				value: {
					contexts: [],
					excludes: [],
					extends: [],
					includes: [],
					presets: [],
					signatures: [],
				},
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
		tree.sources.map((source) => ({
			rootPath: source.rootPath,
			name: source.section.name,
			value: source.section.value,
		})),
		[
			{
				rootPath: await realpath(treeTarget),
				name: "pi-tree",
				value: { excludes: [], extends: [] },
			},
			{
				rootPath: await realpath(directory),
				name: "pi-tree",
				value: { excludes: [], extends: ["./tree-target"] },
			},
		],
	);
});

test("selects full files across ignored and extended roots", async (t) => {
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
		writeFile(join(root, "AGENTS.yml"), "pi-tree:\n  extends: [./packages/tool, ./tool-alias]\n"),
		writeFile(
			join(child, "AGENTS.yml"),
			"pi-tree:\n  extends: [./nested]\n  excludes: [src/excluded.ts, nested/excluded.ts]\n",
		),
		writeFile(join(nested, "AGENTS.yml"), "pi-tree:\n  excludes: [excluded.ts]\n"),
		writeFile(join(root, ".gitignore"), "packages/\ntool-alias/\nroot-full.txt\n"),
		writeFile(join(root, "root-full.txt"), "ignored"),
		writeFile(join(root, "sentinel.md"), "root"),
		writeFile(join(child, "src", "full.ts"), "export {};\n"),
		writeFile(join(child, "src", "excluded.ts"), "export {};\n"),
		writeFile(join(child, "types", "signature.ts"), "export {};\n"),
		writeFile(join(child, "sentinel.md"), "child"),
		writeFile(join(nested, "full.txt"), "nested full"),
		writeFile(join(nested, "signature.ts"), "export {};\n"),
		writeFile(join(nested, "excluded.ts"), "export {};\n"),
		writeFile(join(nested, "sentinel.md"), "nested"),
		symlink(child, childAlias, "dir"),
	]);
	await symlink(join(child, "src", "full.ts"), join(child, "types", "linked.ts"));

	const resolution = await resolvePiTreeSources({ rootPath: root });
	const selected = await resolveFileSelection({ resolution });
	const paths = selected.map(({ displayPath }) => displayPath);
	assert.equal(new Set(selected.map(({ absolutePath }) => absolutePath)).size, selected.length);
	assert.equal(Object.isFrozen(selected), true);
	assert.equal(selected.every(Object.isFrozen), true);
	assert.ok(paths.includes("sentinel.md"));
	assert.ok(paths.includes("packages/tool/src/full.ts"));
	assert.ok(paths.includes("packages/tool/types/signature.ts"));
	assert.ok(paths.includes("packages/tool/nested/full.txt"));
	assert.ok(!paths.includes("root-full.txt"));
	assert.ok(!paths.some((path) => path.endsWith("excluded.ts") || path.endsWith("linked.ts")));
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
		resolvePiPreloadSources({ rootPath: root }),
		(error: unknown) => error instanceof Error && error.message.includes(childSourcePath),
	);
});

test("allows three AGENTS.yml extends levels and rejects a fourth", async (t) => {
	const directory = await temporaryDirectory(t);
	const root = join(directory, "root");
	const first = join(root, "first");
	const second = join(first, "second");
	const third = join(second, "third");
	const fourth = join(third, "fourth");
	await mkdir(fourth, { recursive: true });
	await Promise.all([
		writeFile(join(root, "AGENTS.yml"), "pi-preload:\n  extends: [./first]\n"),
		writeFile(join(first, "AGENTS.yml"), "pi-preload:\n  extends: [./second]\n"),
		writeFile(join(second, "AGENTS.yml"), "pi-preload:\n  extends: [./third]\n"),
		writeFile(join(third, "AGENTS.yml"), "pi-preload: {}\n"),
		writeFile(join(fourth, "AGENTS.yml"), "pi-preload: {}\n"),
	]);

	const resolved = await resolvePiPreloadSources({ rootPath: root });
	assert.deepEqual(
		resolved.sources.map(({ depth }) => depth),
		[3, 2, 1, 0],
	);

	await writeFile(join(third, "AGENTS.yml"), "pi-preload:\n  extends: [./fourth]\n");
	await assert.rejects(
		resolvePiPreloadSources({ rootPath: root }),
		(error: unknown) =>
			error instanceof Error &&
			error.message.includes(`maximum depth of ${MAX_AGENTS_EXTENDS_DEPTH}`) &&
			error.message.includes(join(fourth, "AGENTS.yml")),
	);
});
