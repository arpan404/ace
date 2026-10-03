import type { AgentStatus, ThreadStatus } from "@ace/protocol";

export type Tone = "working" | "needs-you" | "waiting" | "failed" | "done" | "idle";

/** Thread status as shown in lists. The daemon derives it; the client only labels it. */
export function threadStatusLabel(status: ThreadStatus): { label: string; tone: Tone } {
  switch (status.state) {
    case "needs_you":
      return { label: "Needs you", tone: "needs-you" };
    case "working":
      return { label: "Working", tone: "working" };
    case "waiting":
      return { label: `Waiting on ${status.on.replace("_", " ")}`, tone: "waiting" };
    case "failed":
      return { label: "Failed", tone: "failed" };
    case "unresponsive":
      return { label: "Unresponsive", tone: "failed" };
    case "done":
      return { label: "Done", tone: "done" };
    case "new":
      return { label: "New", tone: "idle" };
  }
}

export function agentStatusLabel(status: AgentStatus): { label: string; tone: Tone } {
  switch (status.state) {
    case "starting":
      return { label: "Starting", tone: "working" };
    case "working":
      return { label: "Working", tone: "working" };
    case "blocked":
      return status.on === "human"
        ? { label: "Needs you", tone: "needs-you" }
        : { label: `Waiting on ${status.on.replace("_", " ")}`, tone: "waiting" };
    case "idle":
      return { label: "Idle", tone: "done" };
    case "interrupted":
      return { label: "Interrupted", tone: "idle" };
    case "failed":
      return { label: "Failed", tone: "failed" };
    case "unresponsive":
      return { label: "Unresponsive", tone: "failed" };
  }
}

/**
 * The only mark a thread row shows: a dot for needs you, failed and unresponsive, a spinner
 * while it works, nothing for waiting, done and new.
 */
export type ThreadMarkKind = "needs-you" | "failed" | "unresponsive" | "working" | "none";
export function threadStatusMark(status: ThreadStatus): ThreadMarkKind {
  switch (status.state) {
    case "needs_you":
      return "needs-you";
    case "failed":
      return "failed";
    case "unresponsive":
      return "unresponsive";
    case "working":
      return "working";
    default:
      return "none";
  }
}

/** Subagents beyond the root that are working right now, from the daemon's derived status. */
export function runningSubagents(status: ThreadStatus): number {
  return status.state === "working" ? Math.max(0, status.agents - 1) : 0;
}
