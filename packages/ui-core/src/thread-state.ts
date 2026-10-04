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

export type Attention = "needs-you" | "unread" | undefined;

/**
 * What one thread adds to Home's mark on the rail: it needs you, it has news the person hasn't
 * opened (against this device's first launch, as Home judges it), or nothing. Settled, snoozed
 * (the daemon clears a snooze once it passes), archived and deleted threads add nothing.
 */
export function entryAttention(entry: ThreadListEntry | undefined, baseline: number): Attention {
  if (!entry || entry.archivedAt !== undefined || entry.deletedAt !== undefined) return undefined;
  if (isSettled(entry) || entry.snoozedUntil !== undefined) return undefined;
  if (entry.status.state === "needs_you") return "needs-you";
  return isUnread(entry, baseline) ? "unread" : undefined;
}

/**
 * Home's mark kept as counts, so a changed thread costs one update rather than a pass over the
 * whole list: needs you if any thread needs you, else unread if any has news.
 */
export class AttentionTally {
  private each = new Map<string, "needs-you" | "unread">();
  private needs = 0;
  private news = 0;
  /** What thread `id` now adds (undefined once it adds nothing or has left the list). */
  set(id: string, attention: Attention): void {
    const before = this.each.get(id);
    if (before === attention) return;
    if (before === "needs-you") this.needs--;
    if (before === "unread") this.news--;
    if (attention === "needs-you") this.needs++;
    if (attention === "unread") this.news++;
    if (attention) this.each.set(id, attention);
    else this.each.delete(id);
  }
  clear(): void {
    this.each.clear();
    this.needs = 0;
    this.news = 0;
  }
  get value(): Attention {
    return this.needs > 0 ? "needs-you" : this.news > 0 ? "unread" : undefined;
  }
}
