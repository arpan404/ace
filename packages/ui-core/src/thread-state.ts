import type { ThreadListEntry } from "@ace/protocol";

/*
 * What a thread list entry says about the thread on its own: settled, snoozed, when it last
 * worked, unread. Home's order (`arrange.ts`) and the rail's Home mark read these.
 */

/** In the Settled section. A thread that needs you is never shown settled. */
export function isSettled(entry: ThreadListEntry): boolean {
  return entry.settledAt !== undefined && entry.status.state !== "needs_you";
}

/** Snoozed until a moment still ahead. The daemon clears it once it passes. */
export function isSnoozed(entry: ThreadListEntry, now: number): boolean {
  return entry.snoozedUntil !== undefined && entry.snoozedUntil > now;
}

/** When the thread last did work; organization changes don't count. */
export const activityOf = (entry: ThreadListEntry): number => entry.activityAt ?? entry.updatedAt;

/**
 * New activity the person hasn't opened. Working threads move constantly, so only finished
 * work (done, failed) newer than the last read, or a thread marked unread by hand, counts.
 * Threads never read anywhere compare against this device's first launch.
 */
export function isUnread(entry: ThreadListEntry, baseline: number): boolean {
  if (entry.unread === true) return true;
  if (entry.status.state !== "done" && entry.status.state !== "failed") return false;
  return activityOf(entry) > (entry.readAt ?? baseline);
}

/**
 * What Home's mark on the rail says: a thread on Home needs you, or one has news the person
 * hasn't opened, or neither. Settled and snoozed threads don't count (the daemon clears a snooze
 * once it passes). The rail has no first-launch baseline, so a thread counts as unread only once
 * it was read somewhere or marked unread.
 */
export function homeAttention(
  entries: Iterable<ThreadListEntry>,
): "needs-you" | "unread" | undefined {
  let unread = false;
  for (const entry of entries) {
    if (entry.archivedAt !== undefined || entry.deletedAt !== undefined) continue;
    if (isSettled(entry) || entry.snoozedUntil !== undefined) continue;
    if (entry.status.state === "needs_you") return "needs-you";
    if (isUnread(entry, Number.POSITIVE_INFINITY)) unread = true;
  }
  return unread ? "unread" : undefined;
}
