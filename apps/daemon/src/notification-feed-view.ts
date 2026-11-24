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
