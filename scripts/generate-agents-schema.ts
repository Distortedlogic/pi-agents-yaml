import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentsConfigurationSchema } from "../src/agents-schema.ts";

const outputPath = resolve(import.meta.dirname, "../schemas/AGENTS.schema.json");
await mkdir(resolve(import.meta.dirname, "../schemas"), { recursive: true });
await writeFile(
	outputPath,
	`${JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", ...AgentsConfigurationSchema }, null, "\t")}\n`,
);
