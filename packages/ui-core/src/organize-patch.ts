import type { ThreadListEntry } from "@ace/protocol";
import { activityOf } from "./thread-state.ts";

/*
 * Organize actions applied before the daemon confirms them (UX audit SY-10). Settle, snooze,
 * pin, read, rename, archive and delete each change a few fields of the thread list entry; the
 * client shows that change at once and drops it when the daemon's own entry shows it, or when
 * the daemon refuses the command.
 */

/** What one organize action does to a thread, as the daemon will record it. */
export interface OrganizePatch {
  title?: string;
  pinned?: boolean;
  unread?: boolean;
  settled?: boolean;
  /** A wake time, or null to wake it now. */
  snoozedUntil?: number | null;
  archived?: boolean;
  deleted?: boolean;
}

/** `entry` as it will be once the daemon applies `patch` at `at`. */
export function patchEntry(
  entry: ThreadListEntry,
  patch: OrganizePatch,
  at: number,
): ThreadListEntry {
  const next: ThreadListEntry = { ...entry };
  // Up to now, even when this device's clock is behind the daemon's.
  const latest = Math.max(at, activityOf(entry));
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.pinned !== undefined) next.pinned = patch.pinned;
  if (patch.unread !== undefined) {
    next.unread = patch.unread;
    next.readAt = latest;
  }
  if (patch.settled === true) {
    next.settledAt = at;
    next.settledReason = "manual";
    // Settling clears a snooze, as the daemon does.
    delete next.snoozedUntil;
  } else if (patch.settled === false) {
    delete next.settledAt;
    delete next.settledReason;
    next.activityAt = latest;
  }
  if (patch.snoozedUntil === null) delete next.snoozedUntil;
  else if (patch.snoozedUntil !== undefined) next.snoozedUntil = patch.snoozedUntil;
  if (patch.archived === true) next.archivedAt = at;
  else if (patch.archived === false) delete next.archivedAt;
  if (patch.deleted) next.deletedAt = at;
  return next;
}

/** `entry` with each still-unconfirmed action applied, oldest first. */
export function patchedEntry(
  entry: ThreadListEntry,
  pending: readonly { patch: OrganizePatch; at: number }[],
): ThreadListEntry {
  return pending.reduce((current, action) => patchEntry(current, action.patch, action.at), entry);
}

/**
 * The daemon's entry shows `patch`, so the optimistic copy can go. `before` is the entry when
 * the action was taken: marking read is shown by a new read time, not just the flag. A thread
 * gone from the list shows any action.
 */
export function reflects(
  entry: ThreadListEntry | undefined,
  patch: OrganizePatch,
  before: ThreadListEntry | undefined,
): boolean {
  if (!entry) return true;
  return (
    (patch.title === undefined || entry.title === patch.title) &&
    (patch.pinned === undefined || (entry.pinned === true) === patch.pinned) &&
    (patch.unread === undefined ||
      ((entry.unread === true) === patch.unread && entry.readAt !== before?.readAt)) &&
    (patch.settled === undefined || (entry.settledAt !== undefined) === patch.settled) &&
    (patch.snoozedUntil === undefined || (entry.snoozedUntil ?? null) === patch.snoozedUntil) &&
    (patch.archived === undefined || (entry.archivedAt !== undefined) === patch.archived) &&
    (patch.deleted === undefined || entry.deletedAt !== undefined)
  );
}
