/**
 * ace's MCP server is named `ace`, and every provider already namespaces MCP tools with the
 * server name: Claude and Codex show `mcp__ace__<tool>`, OpenCode and Pi `ace_<tool>`. So ace's
 * tool names are bare (`context`, `delegate`, `thread_read`).
 *
 * The bare name of any spelling of an ace tool: the registered name, a provider-namespaced one,
 * or a name from a toolkit that still carries the old `ace_` prefix. The MCP registry resolves
 * calls and approvals through it, and transcripts recognise and label ace tool calls with it,
 * so every spelling reaches the same tool. Callers establish that the call is ace's first.
 */
export function bareToolName(name: string): string {
  let bare = name.startsWith("mcp__ace__") ? name.slice("mcp__ace__".length) : name;
  while (bare.startsWith("ace_")) bare = bare.slice("ace_".length);
  return bare;
}

/** Finds ace tools for a task; listed to every client. */
export const aceToolSearch = "tools_find";
/**
 * Runs any ace tool by name, for clients that never reload their tool list: `tools_call
 * {name, arguments}`. Approvals, transcripts and privacy treat such a call as its target.
 */
export const aceToolDispatch = "tools_call";

/**
 * The call a `tools_call` runs: its target's bare name and arguments. Any other call, a
 * malformed dispatch, or one naming a meta tool (dispatch never nests) is returned as it came.
 */
export function dispatchedAceCall(name: string, input: unknown): { name: string; input: unknown } {
  if (bareToolName(name) !== aceToolDispatch) return { name, input };
  if (typeof input !== "object" || input === null || !("name" in input)) return { name, input };
  const target = input.name;
  if (typeof target !== "string") return { name, input };
  const bare = bareToolName(target);
  if (bare === aceToolDispatch || bare === aceToolSearch) return { name, input };
  const args = "arguments" in input ? input.arguments : undefined;
  return { name: bare, input: args ?? {} };
}
