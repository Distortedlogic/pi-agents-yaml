---
name: agents-yml-authoring
description: Use when creating, changing, or auditing a repository or Pi package AGENTS.yml, including pi-preload, pi-prompts, and pi-modes. Use separate guidance for AGENTS.md and extension implementation code.
---

# AGENTS.yml authoring

## Procedure

1. Confirm the project or package root and source scope.
2. Read `AGENTS.yml`; create it only when it is missing. Preserve unrelated top-level sections and their order.
3. Change only the requested sections with the rules below.
4. Run `/reload` and check the requested feature.

## Sources and precedence

Extensions read sections from these sources in order:

1. the owned package root;
2. user packages;
3. project packages and the project root, only when Pi trusts the project.

Each section type applies its own rule across sources:

- `pi-modes`: a later source replaces a mode with the same name.
- `pi-prompts`: a duplicate prompt name in two sources is an error.
- `pi-preload`: patterns merge. Preset patterns come before the current project patterns, and extended project scopes come before the scope that names them.

## pi-preload section

`PiPreloadConfigurationSchema` in `pi-agents-yaml` accepts only `presets`, `extends`, `includes`, `signatures`, `excludes`, and `contexts`.

- `extends` takes paths to other project directories.
- `includes` selects complete file content.
- `signatures` selects source with callable bodies folded. It supports `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`, `.py`, `.rs`, and `.go`.
- `excludes` removes paths from the merged file selection.
- `contexts` takes packaged context sources that generate Markdown from the project. `dioxus` is the only source.
- `presets` loads `pi-extension` or `dioxus-rust` before the local configuration.

### Selection

Name root files explicitly. Use a directory and suffix glob for source, so a renamed file stays matched. Use only the suffixes that the directory holds.

For a repository from the Copier template, start from `pi-extensions/template/AGENTS.yml`.

If `includes` and `signatures` select the same resolved file, `includes` wins and loads the complete file.

```yaml
pi-preload:
  presets:
    - pi-extension
  extends:
    - ../shared
  includes:
    - package.json
  signatures:
    - src/**/*.ts
  excludes:
    - src/generated/**
```

Do not select lock files, secrets, generated or vendored directories, binary assets, or large fixtures. The extension also ignores Git-ignored files, lock files, `AGENTS.yml`, `PRELOAD.md`, and `TREE.txt`. Do not use that safeguard to justify a wide glob.

### Limits

`pi-preload/src/index.ts` sets 1,000 unique files, 256 KiB for each original file and emitted block, and 2 MiB for all emitted context. A full-mode file must be UTF-8 text unless an explicit path selects an image. A signature-mode file must be supported UTF-8 source and cannot be binary. Original source bytes and emitted context bytes are counted separately.

The extension collects at session start and writes `PRELOAD.md`. After `/reload`, inspect `PRELOAD.md` and confirm that it contains only the intended context.

## pi-prompts section

The `pi-prompts` schema accepts only `prompts` and `chains`. `prompts` is required when the section exists.

- `prompts` maps a prompt name to an object with a required `body` and an optional `description`.
- `chains` maps a chain name to a list of prompt names. Each member must reference a declared prompt.
- A source root can also hold a `.prompts/` directory. Each `.md` file in it becomes a prompt named after the file without the suffix.

```yaml
pi-prompts:
  prompts:
    review:
      description: Review the changes.
      body: Review the changes.
    summarize:
      body: Summarize the result.
  chains:
    release: [review, summarize]
```

After `/reload`, cycle the prompt catalog and confirm the requested prompts and chains.

## pi-modes section

The `pi-modes` schema maps a mode name to the mode text. A mode name must contain a non-whitespace character. The extension appends the mode text to the user input after a ` --- ` separator, so do not start the text with that separator. When no source declares a mode, only the default `exec` mode exists.

```yaml
pi-modes:
  review: Review the changes.
  plan: Plan the changes.
```

After `/reload`, select or cycle the requested mode and confirm its text.
