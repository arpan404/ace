import type { AgentTaskView, DelegationRecord, Thread } from "@ace/protocol";
import { childStatus } from "./child-status.ts";

/** Canonical status wins over retained outcomes, including provider-native revival. */
export function agentTaskView(
  thread: Thread,
  record: DelegationRecord,
  childrenPending: boolean,
  rootIdle: boolean,
): AgentTaskView {
  const status = childStatus(record, thread).state;
  const state =
    status === "needs_you"
      ? "waiting_on_human"
      : childrenPending && rootIdle
        ? "waiting_on_children"
        : ["done", "failed"].includes(status) &&
            record.phase === "settled" &&
            record.outcome?.outcome === "cancelled"
          ? "cancelled"
          : status === "failed" && record.phase === "settled"
            ? "failed"
            : status === "done" && record.phase === "settled"
              ? record.outcome?.outcome === "cancelled"
                ? "cancelled"
                : "result_available"
              : status === "working"
                ? "working"
                : "result_available";
  return { threadId: thread.id, generation: record.generation, state };
}

/**
 * A delegated child's whole-tree view: never settled while any descendant or human wait is
 * live. `undefined` when the thread is not a delegated child or is gone.
 */
export function childTaskView(
  store: Pick<import("../store.ts").Store, "getThread" | "getMcpAgent">,
  journal: Pick<import("./journal.ts").DelegationJournal, "get" | "liveDescendants">,
  child: import("@ace/protocol").ThreadId,
) {
  const record = journal.get(child);
  const thread = store.getThread(child);
  if (!record || !thread) return undefined;
  const pending = journal.liveDescendants(record.childId).length > 0;
  const root = thread.rootAgentId && store.getMcpAgent(thread.id, thread.rootAgentId);
  const view = agentTaskView(
    thread,
    record,
    pending,
    !!root && ["idle", "blocked", "interrupted"].includes(root.status.state),
  );
  const available = ["result_available", "failed", "cancelled"].includes(view.state) && !pending;
  return { record, view, available };
}
