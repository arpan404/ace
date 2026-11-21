import { subagentLabels, type SubagentState } from "@ace/ui-core";
import {
  spadeAskingWords,
  spadeWorkersTitle,
  type SpadeAgent,
  type SpadeStartedWorker,
} from "@ace/ui-core/spade-chat";

/*
 * The workers a bot started (ADR 0161) as the iPhone's chat draws them: the card's heading, then
 * one row per worker with how it stands now, from ace's thread list for an ace agent and from
 * the bots list for a bot it made. A worker waiting on the person says what for, and names the
 * thread whose request Swift shows inline. Pure: the facts come in, no I/O.
 */

export type SpadeWorkerTone = "needs-you" | "working" | "failed" | "rest";

/** One worker as its row shows it. */
export interface SpadeWorkerLine {
  id: string;
  name: string;
  kind: "ace" | "bot";
  /** An ace agent's thread, which a tap opens and whose requests show under it. */
  thread: string | null;
  /** A bot's conversation, which a tap opens. */
  conversation: string | null;
  tone: SpadeWorkerTone;
  /** How it stands, in words. */
  line: string;
}

/** The workers one call started. */
export interface SpadeWorkersRow {
  kind: "workers";
  title: string;
  workers: SpadeWorkerLine[];
}

/** What the bridge knows of each worker now. */
export interface SpadeWorkerFacts {
  /**
   * An ace agent's thread as ace lists it: its state in a delegated child's words, and what its
   * oldest open request asks for; undefined while the list doesn't say.
   */
  listed(thread: string): { state: SubagentState; asking: string | undefined } | undefined;
  /** A bot from the bots list. */
  bot(id: string): SpadeAgent | undefined;
}

/** Nothing known yet: every worker still at work, never done (AGENTS.md priority 1). */
export const unknownWorkers: SpadeWorkerFacts = { listed: () => undefined, bot: () => undefined };

const tones: Record<SubagentState, SpadeWorkerTone> = {
  human: "needs-you",
  failed: "failed",
  unresponsive: "failed",
  working: "working",
  waiting: "working",
  queued: "working",
  cancelled: "rest",
  done: "rest",
};

/** A bot worker's state from the bots list; one the list doesn't have yet still works. */
function botState(agent: SpadeAgent | undefined): SubagentState {
  if (!agent) return "working";
  if (agent.state === "waiting") return "human";
  if (agent.state === "idle") return "done";
  // Paused by the person: neither running nor done.
  if (agent.state === "paused") return "waiting";
  return "working";
}

/** How a worker stands now, and its row. */
function workerLine(
  worker: SpadeStartedWorker,
  facts: SpadeWorkerFacts,
): { state: SubagentState; line: SpadeWorkerLine } {
  const shared = { id: worker.id, name: worker.name, kind: worker.kind };
  if (worker.kind === "ace") {
    const listed = facts.listed(worker.id);
    const state = listed?.state ?? "working";
    const words = state === "human" ? spadeAskingWords(listed?.asking) : subagentLabels[state];
    return {
      state,
      line: { ...shared, thread: worker.id, conversation: null, tone: tones[state], line: words },
    };
  }
  const agent = facts.bot(worker.id);
  const state = botState(agent);
  const words = agent?.status ?? (state === "human" ? "Needs you" : subagentLabels[state]);
  return {
    state,
    line: {
      ...shared,
      thread: null,
      conversation: agent?.conversation ?? null,
      tone: tones[state],
      line: words,
    },
  };
}

/** The workers one call started, each as it stands now. */
export function spadeWorkersRow(
  workers: readonly SpadeStartedWorker[],
  facts: SpadeWorkerFacts,
): SpadeWorkersRow {
  const read = workers.map((worker) => workerLine(worker, facts));
  return {
    kind: "workers",
    title: spadeWorkersTitle(read.map(({ state }) => state)),
    workers: read.map(({ line }) => line),
  };
}
