import type { Agent } from "@ace/protocol";
import { agentWorkState, isActivelyRunning, type agentTreeWork } from "./agents.ts";

/** A group of agents counted by what happened to each, with their whole subtrees counted in. */
export interface AgentTally {
  /** Agents doing something themselves. */
  working: number;
  /** Agents waiting on a person: an approval or a question, theirs or a subagent's. */
  needsYou: number;
  /** Agents whose own turn ended or paused while work under them, or a person, is pending. */
  waiting: number;
  finished: number;
  failed: number;
  stopped: number;
  unresponsive: number;
}

/**
 * Counts `agents` by tree state: an agent whose subtree still works or waits on a person is
 * working or waiting, never finished, whatever its own turn says.
 */
export function agentTally(
  agents: readonly Agent[],
  work: ReturnType<typeof agentTreeWork>,
  evidence: { fresh: boolean },
): AgentTally {
  const tally: AgentTally = {
    working: 0,
    needsYou: 0,
    waiting: 0,
    finished: 0,
    failed: 0,
    stopped: 0,
    unresponsive: 0,
  };
  for (const agent of agents) {
    const state = agentWorkState(agent, work, evidence);
    if (state.running || state.needsYou) {
      if (state.needsYou) tally.needsYou++;
      else if (isActivelyRunning(agent)) tally.working++;
      else tally.waiting++;
    } else if (agent.status.state === "failed") tally.failed++;
    else if (agent.status.state === "interrupted") tally.stopped++;
    else if (agent.status.state === "unresponsive") tally.unresponsive++;
    else tally.finished++;
  }
  return tally;
}

/**
 * The tally in words, what is still going first: "2 working · 25 finished · 1 failed",
 * "1 needs you · 3 finished". Parts that went wrong are `quiet`, for subtle ink; empty counts
 * are left out.
 */
export function agentTallyParts(tally: AgentTally): { text: string; quiet: boolean }[] {
  const parts: [number, string, boolean][] = [
    [tally.working, "working", false],
    [tally.needsYou, tally.needsYou === 1 ? "needs you" : "need you", false],
    [tally.waiting, "waiting", false],
    [tally.finished, "finished", false],
    [tally.failed, "failed", true],
    [tally.stopped, "stopped", true],
    [tally.unresponsive, "unresponsive", true],
  ];
  return parts
    .filter(([count]) => count > 0)
    .map(([count, word, quiet]) => ({ text: `${count} ${word}`, quiet }));
}
