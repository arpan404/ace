import type { ThreadListEntry } from "@ace/protocol";
import type { OrganizerState } from "./organizer.ts";
import { activityOf, isSettled, isSnoozed } from "./thread-state.ts";

/*
 * Home ordering over the daemon's organization facts (ADR 0057). Settling, auto-settling and
 * snooze expiry are decided by the daemon and arrive on the entry; these rules only read them.
 */

/** Hidden from Home altogether: archived or deleted. */
export function isRemoved(entry: ThreadListEntry): boolean {
  return entry.archivedAt !== undefined || entry.deletedAt !== undefined;
}

/** Older named threads stay compatible; a recorded empty draft never becomes a task by rename. */
function isDraft(entry: ThreadListEntry): boolean {
  return (
    entry.hasSentMessage === false ||
    (entry.hasSentMessage === undefined &&
      entry.status.state === "new" &&
      entry.title === "New thread")
  );
}

/**
 * Requests first, working next, then everything else by recency. Snoozed work stays last.
 */
export function rank(entry: ThreadListEntry, now: number): number {
  if (isSnoozed(entry, now)) return 4;
  switch (entry.status.state) {
    case "needs_you":
      return 0;
    case "working":
      return 1;
    default:
      return 2;
  }
}

/** From this rank on Home orders threads only by recency. */
const restingRank = 2;

export interface Arrangement {
  /** Pinned threads in the person's own order, settled or not: they put them there. */
  pinned: string[];
  /** Requests and working threads. */
  active: string[];
  /** Other threads by recency, with snoozed work last. */
  recent: string[];
  settled: string[];
}

/** A pinned thread's place: higher leads. Pins from before places existed go last. */
export const pinOrderOf = (entry: ThreadListEntry): number => entry.pinOrder ?? 0;

/**
 * Home order: pinned threads first in their own order; then by rank, most recent first within
 * a rank, split into the work in hand and the Recent threads at rest; Settled by recency.
 */
export function arrange(
  entries: readonly ThreadListEntry[],
  state: Pick<OrganizerState, "project">,
  now: number,
): Arrangement {
  const pinned: ThreadListEntry[] = [];
  const active: { entry: ThreadListEntry; rank: number }[] = [];
  const settled: ThreadListEntry[] = [];
  for (const entry of entries) {
    if (isRemoved(entry)) continue;
    // An untouched composer is not a task; sent input gives it a title or live state.
    if (isDraft(entry)) continue;
    if (state.project !== null && entry.workspaceId !== state.project) continue;
    if (entry.pinned === true) pinned.push(entry);
    else if (isSettled(entry)) settled.push(entry);
    else active.push({ entry, rank: rank(entry, now) });
  }
  pinned.sort(
    (a, b) =>
      pinOrderOf(b) - pinOrderOf(a) ||
      activityOf(b) - activityOf(a) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  active.sort((a, b) => a.rank - b.rank || activityOf(b.entry) - activityOf(a.entry));
  settled.sort((a, b) => activityOf(b) - activityOf(a));
  const resting = active.findIndex((row) => row.rank >= restingRank);
  const split = resting < 0 ? active.length : resting;
  return {
    pinned: pinned.map((entry) => entry.id),
    active: active.slice(0, split).map((row) => row.entry.id),
    recent: active.slice(split).map((row) => row.entry.id),
    settled: settled.map((entry) => entry.id),
  };
}

/**
 * The archive: archived threads that weren't deleted, most recently archived first, within the
 * project filter. Home leaves them out; this is where they wait to be restored or deleted.
 */
export function archivedOrder(
  entries: readonly ThreadListEntry[],
  state: Pick<OrganizerState, "project">,
): string[] {
  return entries
    .filter(
      (entry) =>
        entry.archivedAt !== undefined &&
        !isDraft(entry) &&
        entry.deletedAt === undefined &&
        (state.project === null || entry.workspaceId === state.project),
    )
    .toSorted((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || a.id.localeCompare(b.id))
    .map((entry) => entry.id);
}

export interface ProjectCount {
  id: string;
  threads: number;
}

/** Every project with at least one listed thread, by name. */
export function projectCounts(entries: readonly ThreadListEntry[]): ProjectCount[] {
  const counts = new Map<string, number>();
  for (const entry of entries)
    if (!isRemoved(entry) && !isDraft(entry))
      counts.set(entry.workspaceId, (counts.get(entry.workspaceId) ?? 0) + 1);
  return [...counts]
    .map(([id, threads]) => ({ id, threads }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

/**
 * The machine most listed threads run on: the one the daemon itself lives on. Cards name a
 * machine only when it differs from this one.
 */
export function homeMachine(entries: readonly ThreadListEntry[]): string | undefined {
  const counts = new Map<string, number>();
  let best: string | undefined;
  let most = 0;
  for (const entry of entries) {
    const host = entry.details?.machine?.host;
    if (host === undefined) continue;
    const count = (counts.get(host) ?? 0) + 1;
    counts.set(host, count);
    if (count > most) {
      most = count;
      best = host;
    }
  }
  return best;
}
