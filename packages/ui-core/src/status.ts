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
    case "limited":
      return { label: "Limited", tone: "waiting" };
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
 * The only mark a thread row shows: a dot for needs you, failed and unresponsive, a hollow one
 * for a thread held at its account's usage limit, a spinner while it works, nothing for waiting,
 * done and new.
 */
export type ThreadMarkKind =
  | "needs-you"
  | "failed"
  | "unresponsive"
  | "limited"
  | "working"
  | "none";
export function threadStatusMark(status: ThreadStatus): ThreadMarkKind {
  switch (status.state) {
    case "needs_you":
      return "needs-you";
    case "failed":
      return "failed";
    case "unresponsive":
      return "unresponsive";
    case "limited":
      return "limited";
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

/** What a row's status draws beside its words: a ring while working, a check, a warning sign. */
export type PillIcon = "working" | "needs-you" | "waiting" | "done" | "failed";

/** A task row's status: short coloured words, a tone and, while working, when it started. */
export interface TaskPill {
  /** "Working", "Needs you", "Done": the short form; the row's name has the full status. */
  label: string;
  /** A command the label names, shown as code after it: "Watching `bun run dev:relay`". */
  code?: string | undefined;
  tone: Tone;
  icon: PillIcon;
  /** While working: the moment it began, for the live "Working 18s". */
  since?: number | undefined;
}

/**
 * The status a task row shows on its first line, or none: a settled-in thread (done and read, or
 * new) shows its age instead. `since` is when the status last changed (the entry's activity),
 * which is when a working thread started working.
 */
export function taskPill(
  status: ThreadStatus,
  input: { unread: boolean; since: number },
): TaskPill | undefined {
  switch (status.state) {
    case "needs_you":
      return { label: "Needs you", tone: "needs-you", icon: "needs-you" };
    case "working":
      return { label: "Working", tone: "working", icon: "working", since: input.since };
    case "waiting":
      return { label: "Waiting", tone: "waiting", icon: "waiting" };
    case "limited":
      return { label: "Limited", tone: "waiting", icon: "waiting" };
    case "failed":
      return { label: "Failed", tone: "failed", icon: "failed" };
    case "unresponsive":
      return { label: "Unresponsive", tone: "failed", icon: "failed" };
    case "done":
      return input.unread ? { label: "Done", tone: "done", icon: "done" } : undefined;
    case "new":
      return undefined;
  }
}
