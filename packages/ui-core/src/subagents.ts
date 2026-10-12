import type { AgentStatus, ThreadStatus } from "@ace/protocol";

export type SubagentState =
  | "working"
  | "human"
  | "waiting"
  | "unresponsive"
  | "failed"
  | "cancelled"
  | "done";

export const subagentLabels: Record<SubagentState, string> = {
  working: "Running",
  human: "Waiting on you",
  waiting: "Waiting",
  unresponsive: "Not responding",
  failed: "Failed",
  cancelled: "Cancelled",
  done: "Finished",
};

export function subagentState(status: AgentStatus): SubagentState {
  switch (status.state) {
    case "starting":
    case "working":
      return "working";
    case "blocked":
      return status.on === "human" ? "human" : status.on === "subagents" ? "working" : "waiting";
    case "unresponsive":
      return "unresponsive";
    case "failed":
      return "failed";
    case "interrupted":
      return "cancelled";
    case "idle":
      return "done";
  }
}

/** Child-thread status already includes its entire tree, including queued input. */
export function delegatedState(status: ThreadStatus): SubagentState {
  switch (status.state) {
    case "needs_you":
      return "human";
    case "waiting":
    case "limited":
      return "waiting";
    case "unresponsive":
      return "unresponsive";
    case "failed":
      return "failed";
    case "done":
      return "done";
    default:
      return "working";
  }
}

export function subagentTerminal(state: SubagentState): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}

const priority: Record<SubagentState, number> = {
  human: 6,
  working: 5,
  waiting: 4,
  unresponsive: 3,
  failed: 2,
  cancelled: 1,
  done: 0,
};

/** A settled ancestor cannot hide live or waiting descendants. */
export function rollupSubagent(a: SubagentState, b: SubagentState): SubagentState {
  return priority[a] >= priority[b] ? a : b;
}

/** Counts direct children by the status of their entire branch, rather than counting descendants twice. */
export function subagentStatusLine(states: readonly SubagentState[]): string {
  const counts = new Map<SubagentState, number>();
  for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1);
  const words: Record<SubagentState, string> = {
    human: "waiting on you",
    working: "working",
    waiting: "waiting",
    unresponsive: "not responding",
    failed: "failed",
    cancelled: "cancelled",
    done: "done",
  };
  return (Object.keys(priority) as SubagentState[])
    .flatMap((state) => {
      const count = counts.get(state);
      return count ? [`${count} ${words[state]}`] : [];
    })
    .join(" · ");
}
