import { sidebarSettled, snoozeWakeDue } from "@ace/projection";
import type { ThreadListEntry, ThreadListWindow, ThreadReadStateResponse } from "@ace/protocol";

/*
 * What a thread list entry says about the thread on its own: settled, snoozed, when it last
 * worked, unread. Home's order (`arrange.ts`) reads these.
 */

/** In the Settled section. Only working threads are never shown settled. */
export function isSettled(entry: ThreadListEntry): boolean {
  return sidebarSettled(entry);
}

/**
 * Settled threads in all, loaded or not: the daemon's count while it still holds older settled
 * threads back, else undefined (every one is loaded, so the loaded ones are the count).
 */
export function settledTotal(window: ThreadListWindow | undefined): number | undefined {
  return window?.before ? window.total : undefined;
}

/**
 * Snoozed until a moment still ahead, and not woken yet by the event it waits for (a request,
 * failure or finish; a pull request change). The daemon clears both once either happens; this
 * reads the wake here too, so a thread that needs the person never hides while that word travels.
 */
export function isSnoozed(entry: ThreadListEntry, now: number): boolean {
  return entry.snoozedUntil !== undefined && entry.snoozedUntil > now && !snoozeWakeDue(entry);
}

/** Snoozed to a time the person chose: only these stay out of the needs-you counts. */
export function isSnoozedToTime(entry: ThreadListEntry, now: number): boolean {
  return isSnoozed(entry, now) && entry.snoozeWake === undefined;
}

/** When the thread last did work; organization changes don't count. */
export const activityOf = (entry: ThreadListEntry): number => entry.activityAt ?? entry.updatedAt;

/**
 * Device read cursors compare execution sequences. Explicit read/unread choices win.
 * Older snapshots without sequence facts fall back to finished activity newer than the read
 * time, or this device's first launch when it has never read the thread.
 */
export function isUnread(
  entry: ThreadListEntry,
  baseline: number,
  read?: ThreadReadStateResponse,
): boolean {
  if (entry.unread === true) return true;
  if (read?.updatedAt != null && entry.activitySeq !== undefined) {
    if (entry.readAt !== undefined && entry.readAt >= activityOf(entry)) return false;
    return entry.activitySeq > read.lastSeenSeq;
  }
  if (entry.status.state !== "done" && entry.status.state !== "failed") return false;
  return activityOf(entry) > (entry.readAt ?? baseline);
}
