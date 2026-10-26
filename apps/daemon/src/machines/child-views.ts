import { createHash } from "node:crypto";
import type { DelegationOutcome, MonitoredChild, ThreadId, WatchedThread } from "@ace/protocol";
import { clip, elapsedSeconds, settledStates } from "../agent-control/watch-view.ts";
import { savedView, type ChildRow } from "./child-ledger.ts";

/* What the parent's wait and agents_status read from a child's ledger row. Pure. */

export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 24);
export const outcomeOf = (state: WatchedThread["state"]): DelegationOutcome["outcome"] =>
  state === "done" ? "completed" : state === "cancelled" ? "cancelled" : "failed";

/**
 * The child as a wait reads it: its machine's last view, or working until one arrives. A machine
 * that can't be reached says so in its step, never settles it.
 */
export function watchedChild(
  row: ChildRow,
  name: string,
  unreachable: string | undefined,
  now: number,
): { view: WatchedThread; outcome?: DelegationOutcome } {
  const {
    status: _status,
    requests: _requests,
    notice: _notice,
    ...view
  } = savedView(row) ?? {
    threadId: row.id,
    state: "working" as const,
    title: clip(row.role, 120),
    elapsedSeconds: elapsedSeconds(row.created_at, now),
    status: { state: "working" as const, agents: 1 },
    requests: [],
  };
  const shown: WatchedThread = {
    ...view,
    machine: name,
    ...(unreachable && !settledStates.has(view.state) ? { step: unreachable } : {}),
  };
  if (row.settled !== 1) return { view: shown };
  return {
    view: shown,
    outcome: {
      threadId: row.id,
      outcome: outcomeOf(view.state),
      result: view.result ?? "",
      truncated: view.truncated ?? false,
      before: null,
    },
  };
}

/** The child as agents_status lists it under `caller`. */
export function monitoredChild(
  row: ChildRow,
  view: WatchedThread,
  caller: ThreadId,
  name: string,
): MonitoredChild {
  const notice = savedView(row)?.notice;
  return {
    id: row.id,
    ...(row.parent_thread === caller ? {} : { parent: row.parent_thread }),
    role: clip(row.role, 40),
    state: view.state,
    ...(view.step ? { step: clip(view.step, 60) } : {}),
    ...(view.slotLimit !== undefined &&
    view.slotsInUse !== undefined &&
    view.queuePosition !== undefined
      ? {
          slotLimit: view.slotLimit,
          slotsInUse: view.slotsInUse,
          queuePosition: view.queuePosition,
        }
      : {}),
    elapsedSeconds: view.elapsedSeconds,
    ...(view.needs?.[0] ? { needs: view.needs.length, ask: clip(view.needs[0].prompt, 100) } : {}),
    ...(view.last ? { last: clip(view.last, 100) } : {}),
    ...(notice ? { notice: notice.text } : {}),
    machine: clip(name, 64),
  };
}
