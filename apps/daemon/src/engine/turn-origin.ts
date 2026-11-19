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

export interface TurnOrigin {
  /** The root agent's running run; none once its turn ended. */
  root?: RunAt | undefined;
  /** The root's latest turn, running or ended: what the delegation fence compares against. */
  rootTurn?: RunAt | undefined;
  /**
   * The run the calling agent is in itself: the root's for the root, a provider subagent's own
   * for that subagent. Never the root's for a subagent, so one still running from a stopped
   * turn is never taken for the new one.
   */
  origin?: RunAt | undefined;
  /** The thread's last run's `seq`: the boundary a Stop records. */
  latest: number;
}

export function turnOrigin(state: ThreadState | undefined, agentId: string): TurnOrigin {
  if (!state) return { latest: 0 };
  const rootRecord = state.rootKey === undefined ? undefined : state.agents[state.rootKey];
  const key = state.indexes.agentKeysById[agentId];
  return {
    root: runAt(state, rootRecord?.activeRun),
    rootTurn: runAt(state, rootRecord?.activeRun ?? rootRecord?.lastRun),
    origin: key === undefined ? undefined : runAt(state, state.agents[key]?.activeRun),
    latest: state.runSeq ?? 0,
  };
}

/**
 * The run (turn) an agent's tool call belongs to now: its own running run, else the root's
 * running run. None once the turn ended, so nothing turn-scoped (locked use's protected
 * interval, a turn fence) is ever granted to a finished turn.
 */
export function activeRun(state: ThreadState | undefined, agentId: string): string | undefined {
  const { root, origin } = turnOrigin(state, agentId);
  return (origin ?? root)?.id;
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
