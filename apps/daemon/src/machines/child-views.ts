import { createHash } from "node:crypto";
import { InteractionId } from "@ace/protocol";
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

/** What a lost child says: its pairing is gone, and its work there may still be running. */
export const lostLine = (name: string) =>
  `Lost: ${name} is no longer paired; its work there may still be running`;

/**
 * The settled view of a lost child the person stopped tracking: the parent gets this result,
 * which says the work may still be running there (ADR 0099).
 */
export function abandonedView(row: ChildRow, name: string, now: number): MachineThreadView {
  const saved = savedView(row);
  return {
    threadId: row.id,
    state: "cancelled",
    title: saved?.title || clip(row.role, 120),
    elapsedSeconds: saved?.elapsedSeconds ?? elapsedSeconds(row.created_at, now),
    status: { state: "done" },
    requests: [],
    result: `Stopped tracking: ${name} is no longer paired with this machine, so this child can't report back. Its work there may still be running; check on ${name}.`,
    truncated: false,
  };
}

/** The words for a child stopped here whose machine never confirmed it (ADR 0052). */
export const unconfirmedLine = (name: string) =>
  `Stopped · ${name} didn't confirm; its work there may still be running`;
/** The words for a child whose machine stopped reporting it past its lease. */
export const silentLine = (name: string) =>
  `Lost contact: ${name} hasn't reported it; it resumes if ${name} reports again`;

/**
 * The settled view of a child stopped here after every cancel went unconfirmed: cancelled, and
 * saying its machine never confirmed it, so the parent knows its work may still be running.
 */
export function unconfirmedView(row: ChildRow, name: string, now: number): MachineThreadView {
  const saved = savedView(row);
  return {
    threadId: row.id,
    state: "cancelled",
    title: saved?.title || clip(row.role, 120),
    elapsedSeconds: elapsedSeconds(row.created_at, now),
    status: { state: "done" },
    requests: [],
    result: `Stopped here. ${name} hasn't confirmed it stopped, so its work there may still be running; ace keeps sending the cancel until ${name} confirms (agents_status shows it as cancelling until then).`,
    truncated: false,
    contact: "unconfirmed",
  };
}

/**
 * A child its machine stopped reporting, as a wait reads it: no longer live (read as failed, so
 * it releases a wait), saying it lost contact and may resume.
 */
function silentChild(row: ChildRow, name: string, now: number): WatchedThread {
  const saved = savedView(row);
  return {
    threadId: row.id,
    state: "failed",
    title: saved?.title || clip(row.role, 120),
    elapsedSeconds: elapsedSeconds(row.created_at, now),
    step: clip(silentLine(name), 120),
    machine: name,
    contact: "lost",
  };
}

/**
 * A lost child as a wait reads it: needing the person, with the parent's approval about it as
 * its request, never settled.
 */
function lostChild(row: ChildRow, name: string, now: number): WatchedThread {
  const saved = savedView(row);
  const line = lostLine(name);
  return {
    threadId: row.id,
    state: "needs_you",
    title: saved?.title || clip(row.role, 120),
    elapsedSeconds: elapsedSeconds(row.created_at, now),
    step: clip(line, 120),
    needs: row.lost_ask
      ? [{ interactionId: InteractionId.parse(row.lost_ask), kind: "approval", prompt: line }]
      : [],
    machine: name,
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
  if (row.settled !== 1 && row.lost_at !== null) return { view: lostChild(row, name, now) };
  if (row.settled !== 1 && row.silent_since !== null) return { view: silentChild(row, name, now) };
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
      ...(view.failure ? { failure: view.failure } : {}),
      result: view.result ?? view.failure?.message ?? "",
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
  // Stopped here, and its machine hasn't confirmed it ended yet: ace is still sending the cancel.
  const cancelling =
    row.stopped_unconfirmed === 1 || (row.settled === 0 && row.stop_started_at !== null);
  return {
    ...(view.failure ? { failure: view.failure } : {}),
    ...(view.result !== undefined ? { result: view.result } : {}),
    id: row.id,
    ...(row.parent_thread === caller ? {} : { parent: row.parent_thread }),
    role: clip(row.role, 40),
    state: cancelling ? "cancelling" : view.state,
    ...(cancelling
      ? { step: clip(`Cancel sent; waiting for ${name} to confirm`, 60) }
      : view.step
        ? { step: clip(view.step, 60) }
        : {}),
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
    ...(view.contact ? { contact: view.contact } : {}),
  };
}
