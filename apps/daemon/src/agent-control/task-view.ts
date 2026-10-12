import type { AgentTaskView, DelegationRecord, Thread } from "@ace/protocol";

/** Canonical status wins over retained outcomes, including provider-native revival. */
export function agentTaskView(
  thread: Thread,
  record: DelegationRecord,
  childrenPending: boolean,
  rootIdle: boolean,
): AgentTaskView {
  const status = thread.status.state;
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
              : "working";
  return { threadId: thread.id, generation: record.generation, state };
}
