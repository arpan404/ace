import { threadAttention } from "@ace/projection";
import type { ThreadListEntry, ThreadReadStateResponse } from "@ace/protocol";

/*
 * What a thread list entry says about the thread on its own: settled, snoozed, when it last
 * worked, unread. Home's order (`arrange.ts`) reads these.
 */

/** In the Settled section. A thread that needs you is never shown settled. */
export function isSettled(entry: ThreadListEntry): boolean {
  return entry.settledAt !== undefined && entry.status.state === "done" && !threadAttention(entry);
}

/** Snoozed until a moment still ahead. The daemon clears it once it passes. */
export function isSnoozed(entry: ThreadListEntry, now: number): boolean {
  return entry.snoozedUntil !== undefined && entry.snoozedUntil > now;
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
