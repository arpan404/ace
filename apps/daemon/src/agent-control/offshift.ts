import { createHash } from "node:crypto";
import {
  OffshiftConflict,
  OffshiftError,
  OffshiftJournal,
  playbookCatalogue,
  runCard,
  type Executed,
} from "@ace/offshift";
import type { OffshiftAuthor, OffshiftPerson, OffshiftView } from "@ace/protocol/offshift";
import type { OffshiftClientResult, OffshiftPersonOperation } from "@ace/protocol/offshift-person";
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
  /** The thread's provider and model from its record; the model of a child as delegated. */
  const author = (threadId: ThreadId): OffshiftAuthor | undefined => {
    const thread = store.getThread(threadId);
    if (!thread) return undefined;
    const model =
      thread.execution?.model ?? delegations.journal.get(threadId)?.resolvedModel ?? null;
    return { threadId, provider: thread.provider, model };
  };
  /** The owner's checkout revision, as agents copy it into evidence; undefined without Git. */
  const revisionOf = async (root: string, signal?: AbortSignal): Promise<string | undefined> => {
    const workspace = services.workspaceActions;
    if (!workspace) return undefined;
    let source: string;
    try {
      source = await workspace.git.workspaceRevision(root);
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
    // 12 hex digits tell a checkout's states apart.
    return createHash("sha256").update(root).update("\0").update(source).digest("hex").slice(0, 12);
  };
  /** Commits the change with its card event, so clients never see a write that rolled back. */
  const commit = (ownerId: ThreadId, at: number, run: () => Executed) =>
    store.atomic(() => {
      const executed = run();
      const changed = executed.changed;
      if (changed)
        store.appendEvents(
          ownerId,
          [
            {
              type: "offshift.updated",
              card: runCard(changed.run, changed.revision, changed.next),
            },
          ],
          at,
        );
      return executed.result;
    });
  return {
    /**
     * The person's read or change, from a client with the authority already checked. Recorded
     * as `person`, fenced on the version they saw, and published like the agent's changes.
     */
    async person(
      threadId: ThreadId,
      op: OffshiftPersonOperation,
      requestId: string,
      person: OffshiftPerson,
    ): Promise<Omit<OffshiftClientResult, "type" | "requestId">> {
      const thread = store.getThread(threadId);
      if (!thread || thread.deletedAt !== undefined) return { ok: false, error: "not_found" };
      const workspace = services.workspaceActions;
      if (!workspace) return { ok: false, error: "unavailable" };
      await store.writable();
      const root = workspace.root(threadId);
      const revision = await revisionOf(root);
      if (!revision || workspace.root(threadId) !== root)
        return {
          ok: false,
          error: "unavailable",
          message: "This thread's workspace has no Git revision",
        };
      const owner = store.getThread(threadId);
      if (!owner) return { ok: false, error: "not_found" };
      const counts = owner.rootAgentId
        ? delegations.monitor.snapshot({
            sessionId: "person",
            threadId,
            agentId: owner.rootAgentId,
          }).counts
        : { working: 0, needs_you: 0 };
      const at = now();
      const observation = {
        threadId,
        person,
        agent: author(threadId) ?? null,
        now: at,
        revision,
        treeState: treeState(owner.status.state, counts),
        children: counts.working + counts.needs_you,
      };
      try {
        const result = commit(threadId, at, () =>
          journal.executePerson(op, requestId, observation),
        );
        return "run" in result ? { ok: true, view: result } : { ok: false, error: "invalid" };
      } catch (error) {
        if (!(error instanceof OffshiftError)) throw error;
        if (error instanceof OffshiftConflict) {
          // The run as it stands now, so the person sees what changed.
          try {
            const standing = journal.executePerson(
              { action: "get", runId: op.runId },
              requestId,
              observation,
            ).result;
            if ("run" in standing)
              return { ok: false, error: "conflict", message: error.message, view: standing };
          } catch {
            // Fall through to the bare conflict.
          }
          return { ok: false, error: "conflict", message: error.message };
        }
        return { ok: false, error: "invalid", message: error.message };
      }
    },
    async execute(
      caller: McpAttribution,
      operation: Offshift,
      signal: AbortSignal,
    ): Promise<AgentControlResult> {
      const request = operation.request;
      // The catalogue is static data: no run, revision or ancestry is involved.
      if (request.action === "playbooks") return { ok: true, data: playbookCatalogue() };
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
      const workspace = services.workspaceActions;
      if (!workspace) return { ok: false, code: "unavailable", hint: noRevision };
      await store.writable();
      signal.throwIfAborted();
      const root = workspace.root(ownerId);
      // Evidence binds to the owner's checkout. A child in its own worktree has other source
      // identity even at the same commit, so it reports instead of recording.
      if (foreign && workspace.root(caller.threadId) !== root)
        return { ok: false, code: "invalid", hint: otherCheckout };
      const revision = await revisionOf(root, signal);
      if (!revision) return { ok: false, code: "unavailable", hint: noRevision };
      signal.throwIfAborted();
      if (workspace.root(ownerId) !== root) return { ok: false, code: "not_ready" };
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
        const data = commit(ownerId, at, () =>
          journal.execute(request, {
            threadId: ownerId,
            caller: by,
            now: at,
            revision,
            treeState: treeState(owner.status.state, counts),
            children: counts.working + counts.needs_you,
          }),
        );
        return { ok: true, data };
      } catch (error) {
        if (!(error instanceof OffshiftError)) throw error;
        return { ok: false, code: "invalid", hint: error.message };
      }
    },
  };
}

export type Offshifts = ReturnType<typeof createOffshifts>;
