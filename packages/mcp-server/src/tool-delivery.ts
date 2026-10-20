import type { AceClient, ToolListing } from "./toolsets.ts";

/**
 * What `guide` and `tools_find` hand back with the tools they name, decided once per session
 * from how its client lists tools and who the client is. Schemas travel inline only where the
 * model would otherwise never see them, so no session pays for one schema twice.
 */
export interface ToolDelivery {
  /** Return each tool's input schema with its name. */
  readonly schemas: boolean;
  /** How to call the named tools, where that is not simply by name. */
  readonly how?: string | undefined;
}

/** Codex's code-mode models reach MCP tools only from inside `exec`. */
export const codexCallForm = "Inside exec, call these as await tools.mcp__ace__<name>(args).";
const viaToolsCall = "Call these with tools_call {name, arguments}.";

/** What a guide returns about its family's tools. */
export function guideDelivery(listing: ToolListing = "all", client?: AceClient): ToolDelivery {
  if (client === "codex") return { schemas: true, how: codexCallForm };
  if (listing === "static") return { schemas: true, how: viaToolsCall };
  // A core client reloads its list, but the reload may land a step late: the schemas let the
  // agent call a family tool in the same turn.
  return { schemas: listing === "core" };
}

/** What `tools_find` returns about its matches. */
export function findDelivery(listing: ToolListing = "all", client?: AceClient): ToolDelivery {
  if (client === "codex") return { schemas: true, how: codexCallForm };
  if (listing === "static") return { schemas: true, how: viaToolsCall };
  if (listing === "core")
    return {
      schemas: true,
      how: "These are now in your tool list; call them by name with these schemas.",
    };
  return { schemas: true };
}
