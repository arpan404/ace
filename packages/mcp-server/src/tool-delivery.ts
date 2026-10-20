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
/**
 * A core client reloads its list on `tools/list_changed` and gets every schema from it, so a
 * schema returned here too would be paid twice. The reload can land a model step late (OpenCode
 * debounces it), so until a tool is listed the agent reaches it through `tools_call`.
 */
const untilReloaded =
  "These join your tool list when it reloads; call one by name once listed, or with tools_call {name, arguments} before.";

/** What a guide returns about its family's tools. */
export function guideDelivery(listing: ToolListing = "all", client?: AceClient): ToolDelivery {
  if (client === "codex") return { schemas: true, how: codexCallForm };
  if (listing === "static") return { schemas: true, how: viaToolsCall };
  return listing === "core" ? { schemas: false, how: untilReloaded } : { schemas: false };
}

/** What `tools_find` returns about its matches. */
export function findDelivery(listing: ToolListing = "all", client?: AceClient): ToolDelivery {
  if (client === "codex") return { schemas: true, how: codexCallForm };
  if (listing === "static") return { schemas: true, how: viaToolsCall };
  return listing === "core" ? { schemas: false, how: untilReloaded } : { schemas: true };
}
