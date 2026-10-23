import type { Command, CommandResult, ThreadId } from "@ace/protocol";
import type { Engine } from "../engine/index.ts";
import type { Store } from "../store.ts";
import type { DelegationJournal } from "./journal.ts";

/**
 * All accepted sends, regardless of transport, reserve the same generation/accounting. No send
 * is refused because of how many agents are working: counts only order queued launches.
 */
export function delegationCommandPolicy(deps: {
  journal: DelegationJournal;
  engine: Engine;
  store: Store;
  now(): number;
  admits(): boolean;
  cancel(thread: ThreadId, request: string): void;
  /** Cancel what agent `agentId` of the thread and its subagents delegated or are preparing. */
  cancelAgent?(thread: ThreadId, agentId: string, request: string): void;
  changed(): void;
  suspending?(thread: ThreadId): boolean;
  /** Starts a child still waiting for a slot, so explicit input never overtakes its task. */
  launchQueued?(child: ThreadId): void;
  conversationAccepted?(thread: ThreadId): void;
  conversationAdmission?(thread: ThreadId): string | undefined;
  /** The parent's agent whose message is being admitted now, when an agent's tool sends one. */
  requestingAgent?(): string | undefined;
  /** Resumes the thread's delegated children that a daemon restart left held. */
  resumeRestartHeld?(thread: ThreadId, request: string): void;
}) {
  return (command: Command, accept: () => CommandResult): CommandResult => {
    const p = command.payload;
    const fail = (error: string) => ({ commandId: command.id, ok: false, error });
    if (p.type === "thread.interrupt") {
      const accepted = accept();
      // Stopping one of the thread's own agents stops what it and its subagents delegated, and
      // leaves the rest of the thread's delegated work alone.
      const oneAgent =
        p.agentId !== undefined && deps.store.getThread(p.threadId)?.rootAgentId !== p.agentId;
      if (
        accepted.ok &&
        p.cascade &&
        !deps.suspending?.(p.threadId) &&
        deps.journal.get(p.threadId)?.phase !== "cancelling"
      ) {
        if (oneAgent && p.agentId !== undefined)
          deps.cancelAgent?.(p.threadId, p.agentId, command.id);
        else if (!oneAgent) deps.cancel(p.threadId, command.id);
      }
      return accepted;
    }
    if (
      p.type !== "thread.send" &&
      p.type !== "thread.resume" &&
      p.type !== "queue.resume" &&
      p.type !== "thread.switch" &&
      p.type !== "thread.limit"
    )
      return accept();
    const explicit =
      p.type === "thread.resume" ||
      p.type === "queue.resume" ||
      p.type === "thread.switch" ||
      (p.type === "thread.send" &&
        (p.trigger === undefined || p.trigger === "user" || p.trigger === "parent_agent"));
    // Carrying a thread on after a restart carries on the children the restart stopped under
    // it, or it would wait on them forever.
    const carryOn = explicit && p.type !== "thread.switch";
    if (!deps.journal.get(p.threadId)) {
      const rejected = deps.conversationAdmission?.(p.threadId);
      if (rejected) return fail(rejected);
      // A Stop holds automatic wakes until the person or parent speaks again.
      if (deps.journal.stopped(p.threadId) && !explicit) return fail("cancelled");
      const accepted = accept();
      if (accepted.ok) {
        if (deps.journal.stopped(p.threadId)) deps.journal.resumeRoot(p.threadId, deps.now());
        if (carryOn) deps.resumeRestartHeld?.(p.threadId, command.id);
        deps.conversationAccepted?.(p.threadId);
        deps.changed();
      }
      return accepted;
    }
    if (!deps.admits()) return fail("Admission closed");
    if (!explicit && deps.journal.stopped(p.threadId)) return fail("cancelled");
    if (
      deps.journal.get(p.threadId)?.phase === "cancelling" ||
      deps.journal.ancestorStopped(p.threadId)
    )
      return fail("cancelled");
    if (p.type === "thread.send" && explicit && deps.journal.get(p.threadId)?.phase === "created")
      deps.launchQueued?.(p.threadId);
    const edge = deps.journal.get(p.threadId);
    if (!edge) return fail("cancelled");
    const accepted = accept();
    if (!accepted.ok) return accepted;
    if (explicit) deps.journal.resumeMember(p.threadId, deps.now());
    if (carryOn) deps.resumeRestartHeld?.(p.threadId, command.id);
    // Only the parent agent's own message makes the new work its turn's; the person's is theirs.
    if (edge.phase === "settled")
      deps.journal.reopen(
        edge,
        deps.now(),
        p.type === "thread.send" && p.trigger === "parent_agent"
          ? { agentId: deps.requestingAgent?.() }
          : undefined,
      );
    else if (edge.phase === "created") {
      edge.phase = "running";
      deps.journal.save(edge);
    }
    const child = deps.store.getThread(p.threadId);
    if (child) {
      deps.engine.delegationStarted(edge, { ...child, status: { state: "waiting", on: "queue" } });
      deps.engine.updateChild(edge.parentId, {
        ...child,
        status: { state: "waiting", on: "queue" },
      });
    }
    deps.changed();
    return accepted;
  };
}
