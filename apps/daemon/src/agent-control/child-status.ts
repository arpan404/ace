import type { DelegationRecord, Thread, ThreadStatus } from "@ace/protocol";

/** A child waiting for one of its parent's run slots. */
export const queuedStatus: ThreadStatus = { state: "waiting", on: "queue" };
/** What a queued child's step says, for a model reading agents_status or wait. */
export const queuedStep = "queued: starts when a running agent finishes";
/** The result of a child that settled without ever running. */
export function unlaunchedResult(outcome: "cancelled" | "failed"): string {
  return outcome === "cancelled" ? "Stopped before it started." : "It could not be started.";
}

/**
 * The status a parent shows for its child. A settled child that never ran keeps its thread
 * status `new`; it is shown finished, so it never holds its parent open.
 */
export function childStatus(edge: DelegationRecord, thread: Thread): ThreadStatus {
  if (edge.phase !== "settled" || thread.status.state !== "new") return thread.status;
  return { state: edge.outcome?.outcome === "failed" ? "failed" : "done" };
}
