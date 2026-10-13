import { z } from "zod";

const WaitArguments = z.object({ threadIds: z.array(z.string().min(1).max(256)).min(1).max(16) });
const DelegateArguments = z.object({
  wait: z.boolean().optional(),
  waitMs: z.number().optional(),
});
/** Provider spellings of one ace tool: bare, Claude's `mcp__ace__` and OpenCode's `ace_` prefix. */
function bareName(name: string): string {
  const tool = name.startsWith("mcp__ace__") ? name.slice("mcp__ace__".length) : name;
  return tool.startsWith("ace_ace_") || tool === "ace_delegate_task" ? tool.slice(4) : tool;
}
/**
 * Threads a live ace tool call blocks on, for "Waiting for subagents". An empty list means the
 * caller's own children generally (a delegation that waits for the child it creates).
 * Undefined for any other tool, or while the provider has not streamed valid arguments yet.
 */
export function aceWaitTargets(name: string, input: unknown): string[] | undefined {
  const tool = bareName(name);
  if (tool === "ace_wait") {
    const parsed = WaitArguments.safeParse(input);
    return parsed.success ? [...new Set(parsed.data.threadIds)] : undefined;
  }
  if (tool === "delegate_task") {
    const parsed = DelegateArguments.safeParse(input);
    return parsed.success && (parsed.data.wait === true || parsed.data.waitMs !== undefined)
      ? []
      : undefined;
  }
  return undefined;
}
