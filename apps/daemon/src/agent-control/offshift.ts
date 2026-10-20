import { createHash } from "node:crypto";
import { OffshiftError, OffshiftJournal, runCard } from "@ace/offshift";
import type { OffshiftView } from "@ace/protocol/offshift";
import type { AgentControlResult, McpAttribution } from "@ace/protocol";
import type { ThreadStatus } from "@ace/protocol/thread-status";
import type { ServiceContext } from "../services/types.ts";
import type { DelegationService } from "./delegations.ts";
import type { ExtensionOperation } from "./tools.ts";

type Offshift = Extract<ExtensionOperation, { op: "offshift" }>;

const noRevision =
  "This thread's workspace is not a readable Git repository, so offshift cannot bind evidence to a source revision. Do the work without an offshift record and report your checks in your answer; do not retry.";

/** The whole tree's state: the caller's own status, then anything a descendant still holds. */
function treeState(
  status: ThreadStatus["state"],
  counts: { working: number; needs_you: number },
): OffshiftView["treeState"] {
  if (status === "needs_you" || counts.needs_you) return "needs_you";
  if (status === "failed") return "failed";
  if (status === "working" || counts.working) return "working";
  if (status === "waiting" || status === "limited") return "waiting";
  return status === "done" ? "done" : "unknown";
}

/**
 * Durable Offshift runs for the calling thread. Attribution comes from the authenticated MCP
 * lease; no input selects a thread, workspace or command.
 */
export function createOffshifts(context: ServiceContext, delegations: DelegationService) {
  const { store, services, now } = context;
  const journal = new OffshiftJournal(store);
  return {
    async execute(
      caller: McpAttribution,
      operation: Offshift,
      signal: AbortSignal,
    ): Promise<AgentControlResult> {
      const workspace = services.workspaceActions;
      if (!workspace) return { ok: false, code: "unavailable", hint: noRevision };
      await store.writable();
      signal.throwIfAborted();
      const root = workspace.root(caller.threadId);
      let source: string;
      try {
        source = await workspace.git.workspaceRevision(root);
      } catch {
        signal.throwIfAborted();
        return { ok: false, code: "unavailable", hint: noRevision };
      }
      signal.throwIfAborted();
      if (workspace.root(caller.threadId) !== root) return { ok: false, code: "not_ready" };
      const revision = createHash("sha256").update(root).update("\0").update(source).digest("hex");
      // Canonical status is read after the awaited Git I/O. The monitor counts local and remote
      // descendants and unsettled deliveries; a provider turn end never becomes completion.
      const thread = store.getThread(caller.threadId);
      if (!thread || !store.getMcpAgent(caller.threadId, caller.agentId))
        return { ok: false, code: "forbidden" };
      const counts = delegations.monitor.snapshot(caller).counts;
      const at = now();
      try {
        // The card event commits with the run write (atomic nests), so a client never sees a
        // change the journal rolled back, and reads and receipt replays publish nothing.
        const data = store.atomic(() => {
          const executed = journal.execute(operation.request, {
            threadId: caller.threadId,
            now: at,
            revision,
            treeState: treeState(thread.status.state, counts),
          });
          const changed = executed.changed;
          if (changed)
            store.appendEvents(
              caller.threadId,
              [{ type: "offshift.updated", card: runCard(changed.run, changed.revision) }],
              at,
            );
          return executed.result;
        });
        return { ok: true, data };
      } catch (error) {
        if (!(error instanceof OffshiftError)) throw error;
        return { ok: false, code: "invalid", hint: error.message };
      }
    },
  };
}
