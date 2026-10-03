import { delegationBudget } from "@ace/orchestrator";
import type { Command, CommandResult, DelegationPolicy, ThreadId } from "@ace/protocol";
import type { Engine } from "../engine/index.ts";
import type { Store } from "../store.ts";
import type { DelegationJournal } from "./journal.ts";

/** All accepted sends, regardless of transport, reserve the same generation/accounting. */
export function delegationCommandPolicy(deps: {
  journal: DelegationJournal;
  policy: DelegationPolicy;
  engine: Engine;
  store: Store;
  now(): number;
  admits(): boolean;
  cancel(thread: ThreadId, request: string): void;
  changed(): void;
  suspending?(thread: ThreadId): boolean;
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
      p.type !== "thread.limit"
    )
      return accept();
    const edge = deps.journal.get(p.threadId);
    if (!edge) return accept();
    if (!deps.admits()) return fail("Admission closed");
    if (
      p.type === "thread.send" &&
      p.trigger === "subagent_result" &&
      deps.journal.stopped(p.threadId)
    )
      return fail("cancelled");
    if (edge.phase === "cancelling" || deps.journal.ancestorStopped(p.threadId))
      return fail("cancelled");
    const tree = deps.journal.tree(edge.parentId, deps.now());
    const rejection = tree.cancelled
      ? "cancelled"
      : delegationBudget(tree, deps.policy, deps.now());
    if (rejection) return fail(rejection);
    if (
      edge.phase === "settled" &&
      (deps.journal.concurrent(edge.parentId) >= deps.policy.maxConcurrent ||
        deps.journal.activeCount() >= 64)
    )
      return fail("concurrency_limit");
    const accepted = accept();
    if (!accepted.ok) return accepted;
    if (edge.phase === "settled") deps.journal.reopen(edge);
    else if (edge.phase === "created") {
      edge.phase = "running";
      deps.journal.save(edge);
    }
    const child = deps.store.getThread(p.threadId);
    if (child)
      deps.engine.updateChild(edge.parentId, {
        ...child,
        status: { state: "waiting", on: "queue" },
      });
    deps.changed();
    return accepted;
  };
}
