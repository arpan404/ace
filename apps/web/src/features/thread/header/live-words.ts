import type { Agent, ThreadListEntry, ThreadStatus, ThreadRunMetadata } from "@ace/protocol";
import {
  agentTally,
  agentTallyParts,
  agentWorkState,
  listTreeFacts,
  threadRowStatus,
  treeWorking,
  type agentTreeWork,
} from "@ace/ui-core";
import type { Live } from "@/lib/live-connection.ts";

/*
 * Every word, count and dot the Work card and its header icon derive from agent or thread state
 * comes from here. Each takes `live` first, required, and returns the stale presentation before
 * reading any state while the copy isn't current. The `ace/live-actions` lint rule keeps the
 * ui-core formatters these wrap to files named live-words.ts.
 */

type Work = ReturnType<typeof agentTreeWork>;

/**
 * An agent's status with everything under it: never "Done" while its branch still runs; only
 * the stale words while not current.
 */
export function agentWords(live: Live, agent: Agent, work: Work): string {
  if (!live.current) return live.word;
  const state = agentWorkState(agent, work, { fresh: true });
  return !state.running && agent.status.state === "idle" ? "Done" : state.label;
}

/** One part of the settled toggle's tally: "2 working", "1 failed" (quiet). */
export interface TallyPart {
  text: string;
  quiet: boolean;
}

/**
 * The Agents section's split, what still runs or waits first, and its settled toggle's words:
 * the tally of the whole group. Not current, nothing is sorted or counted by state: every agent
 * is one list in its own order, each row saying only the stale words, and there is no toggle.
 */
export function agentListLine(
  live: Live,
  agents: readonly Agent[],
  work: Work,
): { running: Agent[]; settled: Agent[]; toggle: string | TallyPart[] } {
  if (!live.current) return { running: [...agents], settled: [], toggle: live.word };
  const running: Agent[] = [];
  const settled: Agent[] = [];
  for (const agent of agents) {
    const state = agentWorkState(agent, work, { fresh: true });
    if (state.running || state.needsYou) running.push(agent);
    else settled.push(agent);
  }
  return {
    running,
    settled,
    toggle: agentTallyParts(agentTally([...running, ...settled], work, { fresh: true })),
  };
}

/** The header icon's dot: amber while something needs the person, live while the tree works. */
export function treeDot(
  live: Live,
  thread: { status: ThreadStatus; live?: ThreadRunMetadata | undefined } | undefined,
): "needs-you" | "working" | undefined {
  if (!live.current || !thread) return undefined;
  const facts = listTreeFacts(thread);
  if (facts.needsYou) return "needs-you";
  return treeWorking(facts) ? "working" : undefined;
}

/** A parent thread's status in its sidebar row's words; the stale words while the list isn't current. */
export function parentThreadWords(live: Live, parent: ThreadListEntry, now: number): string {
  if (!live.current) return live.word;
  return threadRowStatus(parent, now);
}
