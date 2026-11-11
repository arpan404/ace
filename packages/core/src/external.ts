import type { AgentStatus, ThreadId, ThreadStatus } from "@ace/protocol";
import { lookup, type ThreadState } from "./state.ts";
import { taskHoldsThread } from "./status-inputs.ts";

/** A summary agent follows its independently owned thread, never its parent's process. */
export function externalAgentStatus(status: ThreadStatus, threadId: ThreadId): AgentStatus {
  switch (status.state) {
    case "needs_you":
      return { state: "blocked", on: "human", refs: [threadId] };
    case "working":
      return { state: "working", activity: "responding" };
    case "waiting":
      return {
        state: "blocked",
        on: status.on,
        refs: [threadId],
      };
    case "limited":
      return {
        state: "blocked",
        on: "rate_limit",
        refs: [threadId],
        ...(status.until === undefined ? {} : { until: status.until }),
      };
    case "unresponsive":
      return { state: "unresponsive", lastSignalAt: 0 };
    case "new":
      return { state: "starting" };
    case "failed":
      return { state: "failed", error: { kind: "provider", message: "Delegated thread failed" } };
    case "done":
      return { state: "idle" };
  }
}
/**
 * Result wakes can run beside external children, but never beside local provider work. Commands
 * the agent left running after its final reply (ADR 0116) don't count: they no longer hold it.
 */
export function readyForChildResults(state: ThreadState): boolean {
  if (state.queueSources.provider > 0) return false;
  for (const record of Object.values(state.agents)) {
    if (record.externalStatus) continue;
    if (record.activeRun || record.retry || record.limited || record.disconnectedAt !== undefined)
      return false;
  }
  return (
    Object.keys(state.indexes.pendingInteractions).length === 0 &&
    Object.keys(state.indexes.runningTasks).every((key) => {
      const task = lookup(state.tasks, key);
      return task === undefined || !taskHoldsThread(state, task);
    }) &&
    Object.keys(state.indexes.liveTools).length === 0
  );
}
