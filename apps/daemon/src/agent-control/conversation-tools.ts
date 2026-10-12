import { withinJsonBudget } from "@ace/mcp-server";
import type {
  AgentControlOperation,
  AgentControlResult,
  McpAttribution,
  ThreadStartOperation,
} from "@ace/protocol";
import type { Store } from "../store.ts";
import type { DelegationService } from "./delegations.ts";

export type ConversationStartPort = (
  caller: McpAttribution,
  operation: ThreadStartOperation,
  signal: AbortSignal,
) => Promise<AgentControlResult>;

/** Project scope is supplied before search ranking and cursor construction. */
export async function conversationTool(
  store: Store,
  service: DelegationService,
  caller: McpAttribution,
  operation: AgentControlOperation,
  signal: AbortSignal,
  start?: ConversationStartPort,
): Promise<AgentControlResult | undefined> {
  if (operation.op === "thread.start")
    return start ? start(caller, operation, signal) : { ok: false, code: "unsupported" };
  if (operation.op === "thread.configure") {
    const result = await service.configure(caller, operation, signal);
    return { ok: result.ok, ...(result.ok ? {} : { code: "invalid" as const }) };
  }
  if (operation.op !== "threads.list") return undefined;
  const parent = store.getThread(caller.threadId);
  if (!parent || (operation.workspaceId && operation.workspaceId !== parent.workspaceId))
    return { ok: false, code: "forbidden" };
  let limit = operation.limit;
  for (;;) {
    const data = await store.searchQueries.query({
      text: operation.query,
      scope: "threads",
      mode: "tokens",
      filters: { workspaceId: parent.workspaceId },
      limit,
      ...(operation.cursor ? { cursor: operation.cursor } : {}),
    });
    signal.throwIfAborted();
    if (withinJsonBudget(data, 180 * 1024) && Buffer.byteLength(JSON.stringify(data)) <= 180 * 1024)
      return { ok: true, data };
    if (limit === 1) return { ok: false, code: "limit" };
    // Re-query the same cursor so the returned cursor never skips an omitted row.
    limit = Math.max(1, Math.floor(limit / 2));
  }
}
