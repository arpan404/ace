import { htmlToolCatalog } from "./html-tools.ts";
import { imageToolCatalog } from "./image-tools.ts";
import type { ApprovalTarget } from "@ace/protocol";
import type { z } from "zod";
import { agentControlToolCatalog } from "./agent-control.ts";
import { builtinToolCatalog, handoffToolCatalog } from "./catalog.ts";
import { contextToolCatalog } from "./context-tool.ts";
import { knowledgeToolCatalog } from "./knowledge-tools.ts";
import { metaToolCatalog } from "./meta-tools.ts";
import { bareToolName, dispatchedAceCall } from "./tool-names.ts";
import { describeAceAction } from "./action-target.ts";

interface Definition {
  readonly name: string;
  readonly description: string;
  readonly riskClass?: ApprovalTarget["riskClass"];
  readonly input: z.ZodType;
}
const definitions = new Map<string, Definition>(
  [
    ...agentControlToolCatalog,
    ...builtinToolCatalog,
    ...handoffToolCatalog,
    ...contextToolCatalog,
    ...knowledgeToolCatalog,
    ...htmlToolCatalog,
    ...imageToolCatalog,
    ...metaToolCatalog,
  ].map((entry) => [entry.name, entry]),
);
/**
 * ace's static catalog entry for a tool call, for approvals that arrive without a live registry.
 * Callers must establish ace server identity before using a bare tool name.
 */
export function aceToolAction(name: string, input: unknown): ApprovalTarget | undefined {
  // A `tools_call` is approved as the call it runs.
  const call = dispatchedAceCall(name, input);
  const tool = bareToolName(call.name);
  const definition = definitions.get(tool);
  if (!definition) return undefined;
  const parsed = definition.input.safeParse(call.input);
  if (!parsed.success) return undefined;
  return describeAceAction(tool, definition.description, definition.riskClass, parsed.data);
}
