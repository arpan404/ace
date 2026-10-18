import type { Agent, AgentStatus, ThreadStatus } from "@ace/protocol";

export type SubagentState =
  | "working"
  | "human"
  | "waiting"
  | "unresponsive"
  | "failed"
  | "cancelled"
  | "done";

/** A subagent's status word, always shown beside its name in the transcript. */
export const subagentLabels: Record<SubagentState, string> = {
  working: "Running",
  human: "Needs you",
  waiting: "Waiting",
  unresponsive: "Not responding",
  failed: "Failed",
  cancelled: "Cancelled",
  done: "Done",
};

/** What a group of subagents shows as one: the worst of its children. */
export type SubagentGroupStatus = "human" | "failed" | "working" | "done";

const groupRank: Record<SubagentGroupStatus, number> = { human: 3, failed: 2, working: 1, done: 0 };

const groupOf: Record<SubagentState, SubagentGroupStatus> = {
  human: "human",
  failed: "failed",
  unresponsive: "failed",
  working: "working",
  waiting: "working",
  cancelled: "done",
  done: "done",
};

/**
 * A subagent group's one status, the worst child's: needs you, then failed, then working, then
 * done. Never done while any child works or waits (AGENTS.md priority 1). An empty group is
 * still working: its children have not been seen yet.
 */
export function subagentGroupStatus(states: readonly SubagentState[]): SubagentGroupStatus {
  let worst: SubagentGroupStatus | undefined;
  for (const state of states) {
    const status = groupOf[state];
    if (!worst || groupRank[status] > groupRank[worst]) worst = status;
  }
  return worst ?? "working";
}

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

/**
 * "1 subagent working": the live line's subagent count, in the words of the subagents block's
 * and the Summary's status lines (`subagentStatusLine`), so no surface reads as a different total.
 */
export function workingSubagentsText(count: number): string {
  return `${count} ${count === 1 ? "subagent" : "subagents"} working`;
}

/**
 * The one subagent status line ("1 working · 1 failed"), for the subagents block and the
 * Summary's agent tree alike. Counts direct children by the status of their entire branch,
 * rather than counting descendants twice.
 */
export function subagentStatusLine(states: readonly SubagentState[]): string {
  return subagentStatusCounts(states)
    .map((part) => `${part.count} ${part.word}`)
    .join(" · ");
}

/** The status line's parts, worst first, so each count can take its own status tone. */
export function subagentStatusCounts(
  states: readonly SubagentState[],
): { state: SubagentState; count: number; word: string }[] {
  const counts = new Map<SubagentState, number>();
  for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1);
  return (Object.keys(priority) as SubagentState[]).flatMap((state) => {
    const count = counts.get(state);
    return count ? [{ state, count, word: statusWords[state] }] : [];
  });
}

const statusWords: Record<SubagentState, string> = {
  human: "waiting on you",
  working: "working",
  waiting: "waiting",
  unresponsive: "not responding",
  failed: "failed",
  cancelled: "cancelled",
  done: "done",
};

/**
 * The one subagent-counting rule: each of the main agent's direct subagents, by the state of its
 * whole branch (working while it or anything under it still runs, waiting on you while any of it
 * asks). The live line counts its working ones and the Summary prints `subagentStatusLine` of
 * them, as the subagents block does for its launch, so the totals always agree.
 */
export function subagentBranchStates(
  agents: readonly Pick<Agent, "id" | "origin" | "parentId" | "status">[],
  work: { running: ReadonlySet<string>; needsYou: ReadonlySet<string> },
): SubagentState[] {
  const ids = new Set(agents.map((agent) => agent.id));
  const root = agents.find((agent) => agent.origin === "root");
  return agents.flatMap((agent): SubagentState[] => {
    if (agent.origin === "root") return [];
    // Under another loaded subagent: its branch already counts it.
    const parent = agent.parentId;
    if (parent && parent !== root?.id && ids.has(parent)) return [];
    if (work.needsYou.has(agent.id)) return ["human"];
    if (work.running.has(agent.id)) return ["working"];
    return [subagentState(agent.status)];
  });
}
