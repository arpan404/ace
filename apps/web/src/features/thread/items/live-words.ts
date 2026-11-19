import type { Agent, BackgroundTask } from "@ace/protocol";
import {
  backgroundGroup,
  backgroundTaskLine,
  pluralCount,
  subagentDetail,
  subagentGroupCounts,
  subagentGroupStatus,
  subagentGroupTitle,
  subagentLabels,
  thoughtLabel,
  type SubagentDetail,
  type SubagentGroupStatus,
  type SubagentState,
} from "@ace/ui-core";
import type { Live } from "@/lib/live-connection.ts";
import type { SubagentEntry } from "../lib/subagent-group.ts";

/*
 * Every word, count, tone and action the transcript's agent rows, groups and steps derive from
 * live state comes from here, and each formatter takes `live` first, required: while what it
 * reads isn't current it returns the stale presentation before looking at the state, terminal
 * states included. The `ace/live-actions` lint rule keeps the underlying ui-core formatters to
 * files named live-words.ts, so no component formats a state without saying whether it is current.
 */

/** Each state's status tone (`data-tone`): its words' AA hue. */
const subagentTones: Record<SubagentState, string> = {
  working: "working",
  human: "needs-you",
  waiting: "waiting",
  queued: "idle",
  unresponsive: "unresponsive",
  failed: "failed",
  cancelled: "idle",
  done: "done",
};

const groupTones: Record<SubagentGroupStatus, string> = {
  human: "needs-you",
  failed: "failed",
  working: "working",
  done: "done",
};

/** An agent's status word and tone: only the stale words, no tone, while not current. */
export function subagentStateWords(
  live: Live,
  state: SubagentState,
): { word: string; tone: string | undefined } {
  if (!live.current) return { word: live.word, tone: undefined };
  return { word: subagentLabels[state], tone: subagentTones[state] };
}

/** A part of a group's status: how many are in one state, in that state's tone. */
export interface GroupCount {
  state: SubagentState;
  count: number;
  word: string;
  tone: string;
}

/**
 * A subagent group's header: its title ("3 subagents", "3 subagents ran"), its tone and its
 * counts by state; while not current, how many it holds and the stale words, nothing else.
 */
export function subagentGroupLine(
  live: Live,
  states: readonly SubagentState[],
): {
  title: string;
  status: SubagentGroupStatus | undefined;
  tone: string | undefined;
  word: string | undefined;
  counts: GroupCount[];
} {
  if (!live.current)
    return {
      title: pluralCount(states.length, "subagent"),
      status: undefined,
      tone: undefined,
      word: live.word,
      counts: [],
    };
  const status = subagentGroupStatus(states);
  return {
    title: subagentGroupTitle(states),
    status,
    tone: groupTones[status],
    word: undefined,
    counts: subagentGroupCounts(states).map(({ state, count, word }) => ({
      state,
      count,
      word,
      tone: subagentTones[state],
    })),
  };
}

/**
 * A subagent row's second line and its kind (which decides Review): what it does now, what it
 * waits on, its queue place, why it failed or what it found. Nothing while not current.
 */
export function subagentDetailLine(
  live: Live,
  entry: Pick<
    SubagentEntry,
    "state" | "agentId" | "result" | "slotLimit" | "slotsInUse" | "queuePosition"
  >,
  agent: Pick<Agent, "status"> | undefined,
  toolTitle: string | undefined,
): SubagentDetail {
  if (!live.current) return {};
  return subagentDetail(entry, agent, toolTitle, true);
}

/**
 * A background task group's header and which tasks it lists: while not current, how many it
 * holds and the stale words, never how many run or that they all ran.
 */
export function backgroundGroupLine(
  live: Live,
  tasks: readonly (Pick<BackgroundTask, "status"> | undefined)[],
): { label: string; running: number[]; listed: number[] } {
  const group = backgroundGroup(tasks);
  if (!live.current)
    return { ...group, label: `${pluralCount(tasks.length, "background task")} · ${live.word}` };
  return group;
}

/** A thought's title: "Thinking…" under way, "Thought for 12s" done; stale words while not current. */
export function thoughtTitle(live: Live, done: boolean, took: number | undefined): string {
  if (!live.current && !done) return live.word;
  return thoughtLabel(done, took);
}

/**
 * One background task's status words ("Running in background", "Ran in background"). While not
 * current, only the stale words: it may have ended, or ended differently.
 */
export function backgroundTaskWords(live: Live, status: BackgroundTask["status"]): string {
  if (!live.current) return live.word;
  return backgroundTaskLine(status);
}
