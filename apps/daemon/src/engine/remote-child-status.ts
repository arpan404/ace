import type { ThreadStatus, WatchedState } from "@ace/protocol";

/** The summary agent a delegated child has in its parent's tree, here or on another machine. */
export const childAgentKey = (threadId: string) => `ace-child:${threadId}`;

/**
 * The status a child on another machine gives its summary agent in the parent (ADR 0108), from
 * what that machine last reported. `state` is that machine's own reading of the child (the same
 * one `agents_status` and waits show) and wins over its raw thread status: a child whose queue is
 * held for the person reads as needing them, and a settled one is never working.
 * `asksHere`: its requests are already open in the parent, on this agent, and count there, so
 * the agent itself doesn't count them again. Pure.
 */
export function remoteChildStatus(
  state: WatchedState,
  status: ThreadStatus,
  asksHere: boolean,
): ThreadStatus {
  switch (state) {
    case "done":
    case "cancelled":
      return { state: "done" };
    case "failed":
      return { state: "failed" };
    case "needs_you":
      return asksHere ? { state: "working", agents: 1 } : { state: "needs_you", interactions: 1 };
    case "queued":
      return status.state === "waiting" ? status : { state: "waiting", on: "queue" };
    case "working":
      return status.state === "working" ||
        status.state === "waiting" ||
        status.state === "limited" ||
        status.state === "unresponsive"
        ? status
        : { state: "working", agents: 1 };
  }
}
