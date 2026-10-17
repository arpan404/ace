import { createHash } from "node:crypto";
import { OffshiftError, OffshiftJournal } from "@ace/offshift";
import type { OffshiftRequest, OffshiftView } from "@ace/protocol/offshift";
import type { AgentControlResult, McpAttribution } from "@ace/protocol";
import type { ServiceContext } from "../services/types.ts";
import type { DelegationService } from "./delegations.ts";

/** Attribution comes from the authenticated MCP lease, never from workflow arguments. */
export function createOffshift(context: ServiceContext, delegations: DelegationService) {
  const { store, services, now } = context;
  const journal = new OffshiftJournal(store);
  return async (
    caller: McpAttribution,
    request: OffshiftRequest,
    signal: AbortSignal,
  ): Promise<AgentControlResult> => {
    const workspace = services.workspaceActions;
    if (!workspace) return { ok: false, code: "unavailable" };
    await store.writable();
    signal.throwIfAborted();
    const root = workspace.root(caller.threadId);
    const source = await workspace.git.workspaceRevision(root);
    signal.throwIfAborted();
    if (workspace.root(caller.threadId) !== root) return { ok: false, code: "not_ready" };
    const revision = createHash("sha256").update(root).update("\0").update(source).digest("hex");
    // Read canonical status after awaited Git I/O. The existing monitor includes local and
    // remote descendants and unsettled deliveries; no provider turn-end becomes completion.
    const thread = store.getThread(caller.threadId);
    if (!thread || !store.getMcpAgent(caller.threadId, caller.agentId))
      return { ok: false, code: "forbidden" };
    const counts = delegations.monitor.snapshot(caller).counts;
    let treeState: OffshiftView["treeState"] = "unknown";
    if (thread.status.state === "needs_you" || counts.needs_you) treeState = "needs_you";
    else if (thread.status.state === "failed") treeState = "failed";
    else if (thread.status.state === "working" || counts.working) treeState = "working";
    else if (thread.status.state === "waiting" || thread.status.state === "limited")
      treeState = "waiting";
    else if (thread.status.state === "done") treeState = "done";
    try {
      return {
        ok: true,
        data: journal.execute(request, {
          threadId: caller.threadId,
          now: now(),
          revision,
          treeState,
        }),
      };
    } catch (error) {
      if (!(error instanceof OffshiftError)) throw error;
      return { ok: false, code: "invalid", hint: error.message };
    }
  };
}
