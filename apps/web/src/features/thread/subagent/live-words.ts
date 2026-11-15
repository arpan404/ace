import type { AgentStatus } from "@ace/protocol";
import {
  describeActivity,
  queuedDetail,
  queuedSlotFragment,
  subagentOutcome,
  type QueuePlace,
  type SubagentPhase,
} from "@ace/ui-core";
import type { Live } from "@/lib/live-connection.ts";

/*
 * Every word a subagent's own page derives from its state comes from here. Each takes `live`
 * first, required, and returns the stale presentation before reading any state while the copy
 * isn't current. The `ace/live-actions` lint rule keeps the ui-core formatters these wrap to
 * files named live-words.ts.
 */

/** What a working subagent does now ("running bun test"); nothing once idle or while not current. */
export function subagentStep(
  live: Live,
  status: AgentStatus,
  toolTitle: string | undefined,
): string | undefined {
  if (!live.current || status.state === "idle") return undefined;
  return describeActivity(status, toolTitle);
}

/**
 * How a subagent went, in its bar: the stale words while not current (no ticking time, no
 * "Completed"), a ticking time while it runs, else its outcome ("Completed in 1m 12s").
 */
export function subagentBarWords(
  live: Live,
  phase: SubagentPhase,
  startedAt: number,
  endedAt: number | undefined,
): { kind: "stale"; word: string } | { kind: "running" } | { kind: "outcome"; text: string } {
  if (!live.current) return { kind: "stale", word: live.word };
  if (phase === "running") return { kind: "running" };
  return { kind: "outcome", text: subagentOutcome(phase, startedAt, endedAt, startedAt) };
}

/**
 * Why a queued delegated thread hasn't started: its place ("4 of 4 run slots in use, 2nd in
 * line") or the general reason. While not current, only the stale words: it may have started.
 */
export function queuedLaunchWords(
  live: Live,
  place: { [K in keyof QueuePlace]?: QueuePlace[K] | undefined },
):
  | { kind: "stale"; word: string }
  | { kind: "place"; text: string }
  | { kind: "waiting"; text: string } {
  if (!live.current) return { kind: "stale", word: live.word };
  const { slotLimit, slotsInUse, queuePosition } = place;
  if (slotLimit !== undefined && slotsInUse !== undefined && queuePosition !== undefined)
    return { kind: "place", text: queuedSlotFragment({ slotLimit, slotsInUse, queuePosition }) };
  return { kind: "waiting", text: queuedDetail };
}
