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
  changed(): void;
  suspending?(thread: ThreadId): boolean;
  /** Starts a child still waiting for a slot, so explicit input never overtakes its task. */
  launchQueued?(child: ThreadId): void;
  conversationAccepted?(thread: ThreadId): void;
  conversationAdmission?(thread: ThreadId): string | undefined;
}) {
  return (command: Command, accept: () => CommandResult): CommandResult => {
    const p = command.payload;
    const fail = (error: string) => ({ commandId: command.id, ok: false, error });
    if (p.type === "thread.interrupt") {
      const accepted = accept();
      if (
        accepted.ok &&
        p.cascade &&
        !deps.suspending?.(p.threadId) &&
        deps.journal.get(p.threadId)?.phase !== "cancelling"
      )
        deps.cancel(p.threadId, command.id);
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
    if (!deps.journal.get(p.threadId)) {
      const rejected = deps.conversationAdmission?.(p.threadId);
      if (rejected) return fail(rejected);
      // A Stop holds automatic wakes until the person or parent speaks again.
      if (deps.journal.stopped(p.threadId) && !explicit) return fail("cancelled");
      const accepted = accept();
      if (accepted.ok) {
        if (deps.journal.stopped(p.threadId)) deps.journal.resumeRoot(p.threadId, deps.now());
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
    if (edge.phase === "settled") deps.journal.reopen(edge, deps.now());
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
