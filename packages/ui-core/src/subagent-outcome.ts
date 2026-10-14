import type { SubagentState } from "./subagents.ts";
import { formatElapsed } from "./time.ts";

/**
 * Where a subagent's own view stands, for what replaces its composer: still going (with or
 * without the person), gone silent with nothing under it running (`stalled`: neither working
 * nor ended), or ended one of three ways.
 */
export type SubagentPhase = "running" | "human" | "stalled" | "done" | "failed" | "stopped";

/**
 * The phase of a subagent whose `state` already rolls up its whole subtree: a finished agent
 * with a working child or a pending request is still running, never done, and a silent one
 * with a working child is still running too.
 */
export function subagentPhase(state: SubagentState): SubagentPhase {
  switch (state) {
    case "human":
      return "human";
    case "unresponsive":
      return "stalled";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    default:
      return "running";
  }
}

export const subagentEnded = (phase: SubagentPhase) =>
  phase === "done" || phase === "failed" || phase === "stopped";

/**
 * "Completed in 5m 45s", "Failed after 12s", "Stopped after 1m 2s" or "Working for 40s", from
 * the daemon's own start and end times. `now` stands in for the end while it runs. An ended
 * subagent without a known end says only how it ended; a stalled one never claims to work.
 */
export function subagentOutcome(
  phase: SubagentPhase,
  startedAt: number,
  endedAt: number | undefined,
  now: number,
): string {
  const span = (end: number) => formatElapsed(Math.max(0, end - startedAt));
  switch (phase) {
    case "running":
      return `Working for ${span(Math.max(now, startedAt))}`;
    case "human":
      return "Waiting on you";
    case "stalled":
      return "Not responding";
    case "done":
      return endedAt === undefined ? "Completed" : `Completed in ${span(endedAt)}`;
    case "failed":
      return endedAt === undefined ? "Failed" : `Failed after ${span(endedAt)}`;
    case "stopped":
      return endedAt === undefined ? "Stopped" : `Stopped after ${span(endedAt)}`;
  }
}
