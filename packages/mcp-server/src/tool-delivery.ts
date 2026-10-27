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

/**
 * Codex's code-mode models reach MCP tools only from inside `exec`; its other models load a
 * deferred tool with their tool search, then call it by name.
 */
export const codexCallForm =
  "Inside exec, call these as await tools.mcp__ace__<name>(args); without exec, load them with your tool_search, then call mcp__ace__<name>.";
const viaToolsCall = "Call these with tools_call {name, arguments}.";
/** A Codex session on the fixed list: `tools_call`, which code mode calls from `exec`. */
const codexViaToolsCall =
  "Call these with tools_call {name, arguments}; inside exec, await tools.mcp__ace__tools_call({name, arguments}).";
/**
 * A core client reloads its list on `tools/list_changed` and gets every schema from it, so a
 * schema returned here too would be paid twice. The reload can land a model step late (OpenCode
 * debounces it), so until a tool is listed the agent reaches it through `tools_call`.
 */
const untilReloaded =
  "These join your tool list when it reloads; call one by name once listed, or with tools_call {name, arguments} before.";

/** What a guide returns about its family's tools. */
export function guideDelivery(listing: ToolListing = "all", client?: AceClient): ToolDelivery {
  if (client === "codex") return codexDelivery(listing);
  if (listing === "static") return { schemas: true, how: viaToolsCall };
  return listing === "core" ? { schemas: false, how: untilReloaded } : { schemas: false };
}

/** What `tools_find` returns about its matches. */
export function findDelivery(listing: ToolListing = "all", client?: AceClient): ToolDelivery {
  if (client === "codex") return codexDelivery(listing);
  if (listing === "static") return { schemas: true, how: viaToolsCall };
  return listing === "core" ? { schemas: false, how: untilReloaded } : { schemas: true };
}

/**
 * Codex never shows a code-mode model a schema, so it always gets them inline. Codex never
 * reloads its list, so a session it connected with the fixed list reaches the rest through
 * `tools_call`.
 */
function codexDelivery(listing: ToolListing): ToolDelivery {
  return { schemas: true, how: listing === "static" ? codexViaToolsCall : codexCallForm };
}
