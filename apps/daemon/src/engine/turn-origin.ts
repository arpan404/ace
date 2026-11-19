import { z } from "zod";
import type { ThreadState } from "@ace/core";

/*
 * Which turn a delegation call comes from, read for the delegation fence a Stop sets (ADR 0191,
 * "Late delegations are refused until the next turn runs"). Pure reads of a thread's state.
 */

export interface RunAt {
  id: string;
  /** Its place among the thread's runs (`Run.seq`); 0 for a run recorded before there was one. */
  seq: number;
}

function runAt(state: ThreadState, run: string | undefined): RunAt | undefined {
  const found = run === undefined ? undefined : state.runs[run];
  return found ? { id: found.id, seq: found.seq ?? 0 } : undefined;
}

/**
 * The root's turn (its running run, else its last) and the run the calling agent is in itself:
 * the root's for the root, a provider subagent's own for that subagent. No fallback from one to
 * the other, so a subagent still running from a stopped turn is never taken for the new one.
 * `latest`: the thread's last run's `seq`, the boundary a Stop records.
 */
export function turnOrigin(
  state: ThreadState | undefined,
  agentId: string,
): { root?: RunAt | undefined; origin?: RunAt | undefined; latest: number } {
  if (!state) return { latest: 0 };
  const rootRecord = state.rootKey === undefined ? undefined : state.agents[state.rootKey];
  const key = state.indexes.agentKeysById[agentId];
  return {
    root: runAt(state, rootRecord?.activeRun ?? rootRecord?.lastRun),
    origin: key === undefined ? undefined : runAt(state, state.agents[key]?.activeRun),
    latest: state.runSeq ?? 0,
  };
}

/** The provider's report of a `delegate` call's arguments, read leniently. */
const DelegateArguments = z.looseObject({
  tasks: z.array(z.unknown()).max(64),
});
const DelegateTask = z.looseObject({ requestId: z.string().min(1).max(256) });

/** Request ids of the thread's calls to ace's `delegate` still in flight, at most 64. */
export function delegationsInFlight(state: ThreadState | undefined): string[] {
  const ids: string[] = [];
  if (!state) return ids;
  for (const key of Object.keys(state.indexes.liveTools)) {
    const item = state.items[key];
    if (item?.type !== "tool_call") continue;
    const detail = item.call.detail;
    if (detail.kind !== "mcp" || detail.server !== "ace" || detail.tool !== "delegate") continue;
    const parsed = DelegateArguments.safeParse(detail.arguments);
    if (!parsed.success) continue;
    for (const task of parsed.data.tasks) {
      const found = DelegateTask.safeParse(task);
      if (found.success && ids.length < 64) ids.push(found.data.requestId);
    }
  }
  return ids;
}
