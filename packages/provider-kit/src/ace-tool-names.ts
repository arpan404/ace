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
