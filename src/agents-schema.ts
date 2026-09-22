import { Type } from "typebox";
import { PiPreloadConfigurationSchema, PiTreeConfigurationSchema } from "./preload-schema.ts";

export const AgentsConfigurationSchema = Type.Object(
	{
		"pi-preload": Type.Optional(PiPreloadConfigurationSchema),
		"pi-tree": Type.Optional(PiTreeConfigurationSchema),
	},
	{ additionalProperties: true, $id: "AGENTS.yml" },
);
