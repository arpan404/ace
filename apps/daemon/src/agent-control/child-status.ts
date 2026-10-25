import type { DelegationRecord, QueueFacts, Thread, ThreadStatus } from "@ace/protocol";

/** A child waiting for one of its parent's run slots. */
export const queuedStatus: ThreadStatus = { state: "waiting", on: "queue" };

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
  if (edge.phase !== "settled" || thread.status.state !== "new") return thread.status;
  return { state: edge.outcome?.outcome === "failed" ? "failed" : "done" };
}
