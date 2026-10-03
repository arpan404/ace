import type { ThreadListEntry } from "@ace/protocol";
import type { AutoSettle, OrganizerState, ThreadMark } from "./organizer.ts";

const day = 24 * 60 * 60 * 1000;
export const autoSettleAfter: Record<AutoSettle, number | undefined> = {
  never: undefined,
  "1d": day,
  "3d": 3 * day,
  "1w": 7 * day,
};

/** Hidden from Home altogether: archived by the daemon, deleted here, or archiving. */
export function isRemoved(entry: ThreadListEntry, state: OrganizerState): boolean {
  return (
    entry.archivedAt !== undefined ||
    state.archiving.has(entry.id) ||
    state.marks[entry.id]?.deleted === true
  );
}

/**
 * Settled threads drop to the collapsed section. A thread that needs you never settles. A
 * settled thread comes back when it moves again; a thread unsettled by hand stays until it
 * moves again too. Otherwise a thread that is done settles once it has been quiet for the
 * auto-settle window.
 */
export function isSettled(
  entry: ThreadListEntry,
  mark: ThreadMark | undefined,
  autoSettle: AutoSettle,
  now: number,
): boolean {
  if (entry.status.state === "needs_you") return false;
  if (mark?.settledAt !== undefined && entry.updatedAt <= mark.settledAt) return true;
  if (mark?.unsettledAt !== undefined && entry.updatedAt <= mark.unsettledAt) return false;
  const after = autoSettleAfter[autoSettle];
  return entry.status.state === "done" && after !== undefined && now - entry.updatedAt >= after;
}

export function isSnoozed(mark: ThreadMark | undefined, now: number): boolean {
  return mark?.snoozedUntil !== undefined && mark.snoozedUntil > now;
}

/**
 * New activity the person hasn't opened. Working threads move constantly, so only finished
 * work (done, failed) or a hand-set mark counts.
 */
export function isUnread(
  entry: ThreadListEntry,
  mark: ThreadMark | undefined,
  baseline: number,
): boolean {
  if (mark?.unread) return true;
  if (entry.status.state !== "done" && entry.status.state !== "failed") return false;
  return entry.updatedAt > (mark?.seenAt ?? baseline);
}

/** Needs you, then moving, then trouble, then the rest; a snooze sinks a thread to the end. */
export function rank(entry: ThreadListEntry, mark: ThreadMark | undefined, now: number): number {
  if (isSnoozed(mark, now)) return 4;
  switch (entry.status.state) {
    case "needs_you":
      return 0;
    case "working":
    case "waiting":
      return 1;
    case "failed":
    case "unresponsive":
      return 2;
    default:
      return 3;
  }
}

export interface Arrangement {
  active: string[];
  settled: string[];
}

/** Home order: by rank, pinned first within a rank, then most recent. Settled by recency. */
export function arrange(
  entries: readonly ThreadListEntry[],
  state: OrganizerState,
  now: number,
): Arrangement {
  const active: { entry: ThreadListEntry; rank: number; pinned: boolean }[] = [];
  const settled: ThreadListEntry[] = [];
  for (const entry of entries) {
    if (isRemoved(entry, state)) continue;
    if (state.project !== null && entry.workspaceId !== state.project) continue;
    const mark = state.marks[entry.id];
    if (isSettled(entry, mark, state.autoSettle, now)) settled.push(entry);
    else active.push({ entry, rank: rank(entry, mark, now), pinned: mark?.pinned === true });
  }
  active.sort(
    (a, b) =>
      a.rank - b.rank ||
      Number(b.pinned) - Number(a.pinned) ||
      b.entry.updatedAt - a.entry.updatedAt,
  );
  settled.sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    active: active.map((row) => row.entry.id),
    settled: settled.map((entry) => entry.id),
  };
}

export interface ProjectCount {
  id: string;
  threads: number;
}

/** Every project with at least one listed thread, by name. */
export function projectCounts(
  entries: readonly ThreadListEntry[],
  state: OrganizerState,
): ProjectCount[] {
  const counts = new Map<string, number>();
  for (const entry of entries)
    if (!isRemoved(entry, state))
      counts.set(entry.workspaceId, (counts.get(entry.workspaceId) ?? 0) + 1);
  return [...counts]
    .map(([id, threads]) => ({ id, threads }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
}
