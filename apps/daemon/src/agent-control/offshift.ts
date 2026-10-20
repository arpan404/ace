import { createHash } from "node:crypto";
import {
  OffshiftError,
  OffshiftJournal,
  OffshiftProjectRoles,
  resolveRole,
  runCard,
  type ResolvedRole,
} from "@ace/offshift";
import type { OffshiftAuthor, OffshiftRole, OffshiftView } from "@ace/protocol/offshift";
import type { AgentControlResult, McpAttribution, ThreadId } from "@ace/protocol";
import type { ThreadStatus } from "@ace/protocol/thread-status";
import type { ServiceContext } from "../services/types.ts";
import type { DelegationService } from "./delegations.ts";
import type { ExtensionOperation } from "./tools.ts";

type Offshift = Extract<ExtensionOperation, { op: "offshift" }>;

const noRevision =
  "This thread's workspace is not a readable Git repository, so offshift cannot bind evidence to a source revision. Do the work without an offshift record and report your checks in your answer; do not retry.";
const otherCheckout =
  "You work in a different checkout from the run owner, so your check cannot be bound to its revision. Report the check to the owner in your answer and let it record the evidence.";
const notDescendant =
  "runOwner must be a thread that delegated you (directly or through other children) and is still your live ancestor. Omit runOwner to use your own runs.";

/** The whole tree's state: the owner's own status, then anything a descendant still holds. */
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
 * Durable Offshift runs. Attribution comes from the authenticated MCP lease. The one input that
 * selects a thread is `runOwner`, and only for a live descendant reading or recording evidence on
 * an ancestor's run; nothing selects a workspace or command.
 */
export function createOffshifts(context: ServiceContext, delegations: DelegationService) {
  const { store, services, now } = context;
  const journal = new OffshiftJournal(store);
  const projectRoles = new OffshiftProjectRoles(store);
  /** The thread's provider and model from its record; the model of a child as delegated. */
  const author = (threadId: ThreadId): OffshiftAuthor | undefined => {
    const thread = store.getThread(threadId);
    if (!thread) return undefined;
    const model =
      thread.execution?.model ?? delegations.journal.get(threadId)?.resolvedModel ?? null;
    return { threadId, provider: thread.provider, model };
  };
  const workspaceOf = (threadId: ThreadId) => store.getThread(threadId)?.workspaceId;
  return {
    /**
     * The selection a delegation by `role` takes for `caller`: its active run's role, else the
     * project default; undefined when neither names it.
     */
    roleFor(caller: McpAttribution, role: OffshiftRole): ResolvedRole | undefined {
      const workspace = workspaceOf(caller.threadId);
      return resolveRole(
        role,
        journal.activeRoles(caller.threadId),
        workspace ? projectRoles.get(workspace) : undefined,
      );
    },
    async execute(
      caller: McpAttribution,
      operation: Offshift,
      signal: AbortSignal,
    ): Promise<AgentControlResult> {
      const request = operation.request;
      const ownerId = operation.runOwner ?? caller.threadId;
      const foreign = ownerId !== caller.threadId;
      if (foreign) {
        if (request.action !== "get" && request.action !== "evidence")
          return {
            ok: false,
            code: "invalid",
            hint: "With runOwner you may only get the run or record evidence; the owner makes every other change.",
          };
        // A live descendant only: delegated under the owner, and not being cancelled.
        if (
          !delegations.journal.isDescendant(caller.threadId, ownerId) ||
          delegations.journal.fenced(caller.threadId)
        )
          return { ok: false, code: "forbidden", hint: notDescendant };
      }
      if ("scope" in request) {
        await store.writable();
        signal.throwIfAborted();
        const workspace = workspaceOf(caller.threadId);
        if (!workspace || !store.getMcpAgent(caller.threadId, caller.agentId))
          return { ok: false, code: "forbidden" };
        return {
          ok: true,
          data: { scope: "project", roles: projectRoles.set(workspace, request.roles) },
        };
      }
      const workspace = services.workspaceActions;
      if (!workspace) return { ok: false, code: "unavailable", hint: noRevision };
      await store.writable();
      signal.throwIfAborted();
      const root = workspace.root(ownerId);
      // Evidence binds to the owner's checkout. A child in its own worktree has other source
      // identity even at the same commit, so it reports instead of recording.
      if (foreign && workspace.root(caller.threadId) !== root)
        return { ok: false, code: "invalid", hint: otherCheckout };
      let source: string;
      try {
        source = await workspace.git.workspaceRevision(root);
      } catch {
        signal.throwIfAborted();
        return { ok: false, code: "unavailable", hint: noRevision };
      }
      signal.throwIfAborted();
      if (workspace.root(ownerId) !== root) return { ok: false, code: "not_ready" };
      const revision = createHash("sha256").update(root).update("\0").update(source).digest("hex");
      // Canonical status is read after the awaited Git I/O. The monitor counts local and remote
      // descendants and unsettled deliveries; a provider turn end never becomes completion.
      const owner = store.getThread(ownerId);
      const by = author(caller.threadId);
      if (!owner || !by || !store.getMcpAgent(caller.threadId, caller.agentId))
        return { ok: false, code: "forbidden" };
      const counts = delegations.monitor.snapshot({ ...caller, threadId: ownerId }).counts;
      const at = now();
      try {
        // The card event commits with the run write (atomic nests), so a client never sees a
        // change the journal rolled back, and reads and receipt replays publish nothing.
        const data = store.atomic(() => {
          const executed = journal.execute(request, {
            threadId: ownerId,
            caller: by,
            now: at,
            revision,
            treeState: treeState(owner.status.state, counts),
            children: counts.working + counts.needs_you,
          });
          const changed = executed.changed;
          if (changed)
            store.appendEvents(
              ownerId,
              [
                {
                  type: "offshift.updated",
                  card: runCard(changed.run, changed.revision, projectRoles.get(owner.workspaceId)),
                },
              ],
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
