import type { DelegationRecord, QueueFacts, Thread, ThreadStatus } from "@ace/protocol";

/** A child waiting for one of its parent's run slots. */
export const queuedStatus: ThreadStatus = { state: "waiting", on: "queue" };
/** What a queued child's step says, for a model reading agents_status or wait. */
export const queuedStep = "queued: starts when a running agent finishes";
/**
 * What a parent shows for a child it just sent input to. A child at rest reads as queued until
 * its run starts, so the parent never looks done meanwhile. A child already running keeps its
 * own status: no status change follows to correct a queued reading, so it would stick.
 */
export function messagedChildStatus(status: ThreadStatus): ThreadStatus {
  return ["done", "failed", "new"].includes(status.state) ? queuedStatus : status;
}
/** The result of a child that settled without ever running. */
export function unlaunchedResult(outcome: "cancelled" | "failed"): string {
  return outcome === "cancelled" ? "Stopped before it started." : "It could not be started.";
}

/**
 * A queued child's status with its place: the parent's slot limit, slots in use and its queue
 * place. Without facts it reads as before, so older paths still render the current text.
 */
export function queuedChildStatus(facts: QueueFacts | undefined): ThreadStatus {
  return facts ? { state: "waiting", on: "queue", ...facts } : queuedStatus;
}

/**
 * The status a parent shows for its child. A settled child that never ran keeps its thread
 * status `new`; it is shown finished, so it never holds its parent open.
 */
export function childStatus(edge: DelegationRecord, thread: Thread): ThreadStatus {
  if (
    edge.phase === "settled" &&
    thread.status.state === "limited" &&
    edge.outcome?.failure?.code === "usage_limited"
  )
    return { state: "failed" };
  if (edge.phase !== "settled" || thread.status.state !== "new") return thread.status;
  return { state: edge.outcome?.outcome === "failed" ? "failed" : "done" };
}
