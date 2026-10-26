import { withinJsonBudget } from "@ace/mcp-server";
import type {
  AgentControlOperation,
  AgentControlResult,
  McpAttribution,
  ThreadStartOperation,
} from "@ace/protocol";
import { WorkspaceId } from "@ace/protocol";
import type { Store } from "../store.ts";
import { resolveProject } from "./projects.ts";
import type { DelegationService } from "./delegations.ts";
import type { ModelLoadBudget } from "./model-load-budget.ts";

export type ConversationStartPort = (
  caller: McpAttribution,
  operation: ThreadStartOperation,
  signal: AbortSignal,
  /** The call's budget for waiting on model lists, shared with matching its model name. */
  budget?: ModelLoadBudget,
) => Promise<AgentControlResult>;

/** Project scope is supplied before search ranking and cursor construction. */
export async function conversationTool(
  store: Store,
  service: DelegationService,
  caller: McpAttribution,
  operation: AgentControlOperation,
  signal: AbortSignal,
  start?: ConversationStartPort,
  budget?: ModelLoadBudget,
): Promise<AgentControlResult | undefined> {
  if (operation.op === "thread.start")
    return start ? start(caller, operation, signal, budget) : { ok: false, code: "unsupported" };
  if (operation.op === "thread.configure") {
    const result = await service.configure(caller, operation, signal);
    return { ok: result.ok, ...(result.ok ? {} : { code: "invalid" as const }) };
  }
  if (operation.op !== "threads.list") return undefined;
  const parent = store.getThread(caller.threadId);
  if (!parent) return { ok: false, code: "forbidden" };
  let workspaceId = operation.workspaceId ?? parent.workspaceId;
  if (operation.project) {
    const target = resolveProject(store, operation.project);
    if (!target.ok) return { ok: false, code: target.code, hint: target.hint };
    workspaceId = WorkspaceId.parse(target.project.id);
  }
  // Another project's threads are the person's to show, to an agent acting for them.
  if (workspaceId !== parent.workspaceId && !service.actsForPerson(caller))
    return {
      ok: false,
      code: "forbidden",
      hint: "Other projects' threads need full access; ask the person to raise this thread's access.",
    };
  let limit = operation.limit;
  for (;;) {
    const data = await store.searchQueries.query({
      text: operation.query,
      scope: "threads",
      mode: "tokens",
      filters: { workspaceId },
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
