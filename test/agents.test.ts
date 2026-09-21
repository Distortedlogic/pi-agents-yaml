import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { CONFIG_DIR_NAME, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	discoverAgentsSources,
	loadAgentsSection,
	PiPreloadConfigurationSchema,
	parseAgentsSection,
	parseAgentsYaml,
	resolveAgentsGraph,
	resolveFileSelection,
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
		writeFile(join(projectRoot, "AGENTS.yml"), "selected:\n  enabled: true\n"),
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
				"  presets: [base, extra]",
				"  extends: [./child, ./child-alias]",
				"  contexts: [root-local]",
				"  includes: ['*.txt']",
				"  excludes: [root-only.txt]",
				"",
			].join("\n"),
		),
		writeFile(join(child, "AGENTS.yml"), "pi-preload:\n  contexts: [child-context]\n  includes: ['*.txt']\n"),
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

	const graph = await resolveAgentsGraph({
		rootPath: root,
		sectionName: "pi-preload",
		schema: PiPreloadConfigurationSchema,
		presetDirectory,
	});
	assert.deepEqual(
		graph.nodes.map(({ rootPath }) => rootPath),
		[await realpath(child), await realpath(root)],
	);
	const rootConfiguration = graph.nodes.at(-1)?.section?.value;
	assert.deepEqual(rootConfiguration?.contexts, ["base-context", "extra-context", "root-local"]);
	assert.deepEqual(rootConfiguration?.includes, ["base/*.txt", "extra/*.txt", "*.txt"]);
	assert.deepEqual(rootConfiguration?.excludes, ["base-ignore.txt", "extra-ignore.txt", "root-only.txt"]);
	assert.deepEqual(
		graph.nodes.flatMap((node) =>
			(node.section?.value.contexts ?? []).map((context) => ({ context, rootPath: node.rootPath })),
		),
		[
			{ context: "child-context", rootPath: await realpath(child) },
			{ context: "base-context", rootPath: await realpath(root) },
			{ context: "extra-context", rootPath: await realpath(root) },
			{ context: "root-local", rootPath: await realpath(root) },
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

	const graph = await resolveAgentsGraph({
		rootPath: root,
		sectionName: "pi-preload",
		schema: PiPreloadConfigurationSchema,
	});
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
		resolveAgentsGraph({
			rootPath: root,
			sectionName: "pi-preload",
			schema: PiPreloadConfigurationSchema,
		}),
		(error: unknown) => error instanceof Error && error.message.includes(childSourcePath),
	);
});
