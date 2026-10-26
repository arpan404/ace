import { createHash } from "node:crypto";
import type {
  DelegationOutcome,
  MachineThreadView,
  MonitoredChild,
  ThreadId,
  WatchedThread,
} from "@ace/protocol";
import { clip, elapsedSeconds, settledStates } from "../agent-control/watch-view.ts";
import { savedView, type ChildRow } from "./child-ledger.ts";
import { MachineFailure } from "./transport.ts";

/* What the parent's wait and agents_status read from a child's ledger row. Pure. */

export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 24);
export const outcomeOf = (state: WatchedThread["state"]): DelegationOutcome["outcome"] =>
  state === "done" ? "completed" : state === "cancelled" ? "cancelled" : "failed";

/** Why a machine can't be read or won't take a message yet, short enough for a status row. */
function refusedWhy(error: unknown): string {
  if (!(error instanceof MachineFailure)) return "not answering; retrying";
  if (error.kind === "offline") return "unreachable; retrying";
  if (error.kind === "disconnected") return "connection lost; retrying";
  switch (error.refusal) {
    case "machine_opted_out":
      return "agents from other machines are off there";
    case "machine_forbidden":
      return "agents from here may only read there";
    case "unauthorized":
      return "it no longer accepts this pairing";
    default:
      return clip(error.message, 80) || "refused; retrying";
  }
}
/** The child's machine could not be read: the child stays as last seen, and says why. */
export const unreadReason = (name: string, error: unknown) => `${name}: ${refusedWhy(error)}`;
/** A message to the child is still unanswered after this attempt: the child says why it waits. */
export const heldMessageReason = (name: string, error: unknown) =>
  `Message waits on ${name}: ${refusedWhy(error)}`;

/**
 * The settled view of a child whose pairing is gone: its machine can never be asked or told
 * anything again, so the parent gets this as its result instead of waiting forever (ADR 0099).
 */
export function lostView(row: ChildRow, name: string, now: number): MachineThreadView {
  const saved = savedView(row);
  return {
    threadId: row.id,
    state: "failed",
    title: saved?.title || clip(row.role, 120),
    elapsedSeconds: saved?.elapsedSeconds ?? elapsedSeconds(row.created_at, now),
    status: { state: "failed" },
    requests: [],
    result: `Lost: ${name} is no longer paired with this machine, so this child can't report back or be stopped from here. Any work it started there may still be running; check on that machine.`,
    truncated: false,
  };
}

/**
 * The child as a wait reads it: its machine's last view, or working until one arrives. A machine
 * that can't be read, or won't take its message yet, says so in its step (`waitingOn`), never
 * settles it.
 */
export function watchedChild(
  row: ChildRow,
  name: string,
  waitingOn: string | undefined,
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
    ...(waitingOn && !settledStates.has(view.state) ? { step: clip(waitingOn, 120) } : {}),
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
