import type { InboxFeed } from "@ace/notify";
import type { Notification, NotificationFeed, ThreadId } from "@ace/protocol";

/**
 * A catch-up feed as one socket may read it (ADR 0221): on an organization's host a member sees
 * only alerts and retractions of trees they may read now, and a summary only when it names no
 * other tree. The cursor still moves past what was withheld: that feed is this device's own, so
 * its checkpoint covers only what it may see. Pure.
 */
export function visibleFeed(
  feed: InboxFeed,
  reads: (thread: ThreadId) => boolean,
): NotificationFeed {
  const visible = (notification: Notification) =>
    reads(notification.threadId) && (notification.threadIds ?? []).every(reads);
  return {
    cursor: feed.cursor,
    entries: feed.entries.filter((entry) => visible(entry.notification)),
    retracted: feed.retracted.filter((entry) => reads(entry.threadId)).map((entry) => entry.id),
  };
}

/**
 * A member's feed on an organization's host: as `visibleFeed`, but the cursor stops at the newest
 * entry the member's own device holds, so it cannot be watched rising with the host's other
 * alerts. A phone that sees nothing new keeps its checkpoint. Pure.
 */
export function memberFeed(
  feed: InboxFeed,
  reads: (thread: ThreadId) => boolean,
): NotificationFeed {
  const visible = visibleFeed(feed, reads);
  return { ...visible, cursor: Math.min(feed.cursor, feed.seen) };
}

/**
 * The ids to hand the notification worker, which keeps at most `limit`. `linked` is ordered
 * most recently seen first, so what is cut is the stalest; `cut` says how many. Pure.
 */
export function capLinked<T>(linked: readonly T[], limit: number): { ids: T[]; cut: number } {
  return { ids: linked.slice(0, limit), cut: Math.max(0, linked.length - limit) };
}

/** What an organization member reads and checkpoints while their feed is empty. */
export const emptyMemberFeed: NotificationFeed = { cursor: 0, entries: [], retracted: [] };
