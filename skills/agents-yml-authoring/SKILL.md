---
name: agents-yml-authoring
description: Use when creating, changing, or auditing AGENTS.yml in a project or Pi package, including pi-preload, pi-prompts, and pi-modes.
---

# AGENTS.yml authoring

## Procedure

1. Confirm the project or package root and source scope.
2. Read `AGENTS.yml`; create it only when it is missing. Preserve unrelated top-level sections and their order.

Pi applies `AGENTS.yml` changes after `/reload`.

## Sources and precedence

Extensions read sections from these sources in order:

1. the owned package root;
2. user packages;
3. project packages;
4. the project root.

Pi reads project packages and the project root only when it trusts the project.

Each section type applies its own rule across sources:

- `pi-modes`: a later source replaces a mode with the same name.
- `pi-prompts`: a duplicate prompt name in two sources is an error.
- `pi-preload`: patterns merge. Preset patterns come before the current project patterns, and extended project scopes come before the scope that names them.

The authoritative schemas are `PiPreloadConfigurationSchema`, `pi-prompts/agents.ts`, and `pi-modes/agents.ts`.

## pi-preload section

`PiPreloadConfigurationSchema` in `pi-agents-yaml` accepts only `presets`, `extends`, `includes`, `signatures`, `excludes`, and `contexts`.

- `extends` takes paths to other project directories.
- `includes` selects complete file content.
- `signatures` selects source with callable bodies folded. It supports `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`, `.py`, `.rs`, and `.go`.
- `excludes` removes paths from the merged file selection.
- `contexts` takes packaged context sources that generate Markdown from the project. `dioxus` is the only source.
- `presets` accepts `pi-extension` and `dioxus-rust`.

### Selection

Name root files explicitly. Use a directory and suffix glob for source, so a renamed file stays matched. Use only the suffixes that the directory holds.

If `includes` and `signatures` select the same resolved file, `includes` wins and loads the complete file.

Use narrow globs that exclude secrets, generated or vendored content, binaries, lock files, and large fixtures.

### Limits

`pi-preload/src/index.ts` sets limits of 1,000 files, 256 KiB for each source or emitted block, and 2 MiB for emitted context. A full-mode file must be UTF-8 text unless an explicit path selects an image. A signature-mode file must be supported UTF-8 source and cannot be binary.

After a preload selection change, inspect `PRELOAD.md` after `/reload`.

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

## pi-modes section

The `pi-modes` schema maps a mode name directly to its text. The extension adds a ` --- ` separator before that text, so omit the separator from the stored value.
