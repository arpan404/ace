import { activityReadLimits, type ActivityItemRef, type ActivityReadCursor } from "@ace/protocol";

/*
 * The Activity read cursor's rules (protocol `activity.reads`), shared by the daemon that
 * stores it, the fake daemon, and the client that applies a mark before the daemon confirms
 * it. Pure, so all three agree.
 */

export interface ActivityReadChange {
  read?: readonly ActivityItemRef[] | undefined;
  unread?: readonly ActivityItemRef[] | undefined;
  allBefore?: number | undefined;
}

/** Whether the cursor counts an item read. */
export function isActivityRead(cursor: ActivityReadCursor, item: ActivityItemRef): boolean {
  return item.at <= cursor.before
    ? !cursor.unread.some((entry) => entry.id === item.id)
    : cursor.read.some((entry) => entry.id === item.id);
}

const newestFirst = (a: ActivityItemRef, b: ActivityItemRef) => b.at - a.at;

/**
 * A change applied to a cursor. Pure, so the daemon and the fake daemon agree: `allBefore`
 * moves `before` forward (dropping marks it now covers), then each read or unread mark lands
 * on whichever side of `before` its item is.
 */
export function applyActivityReads(
  cursor: ActivityReadCursor,
  change: ActivityReadChange,
): ActivityReadCursor {
  const before = Math.max(cursor.before, change.allBefore ?? cursor.before);
  const read = new Map(
    cursor.read.filter((item) => item.at > before).map((item) => [item.id, item]),
  );
  const unread = new Map(
    // "Mark all read" clears unread marks it covers; older ones it didn't move past stay.
    cursor.unread
      .filter((item) => change.allBefore === undefined || item.at > change.allBefore)
      .map((item) => [item.id, item]),
  );
  for (const item of change.read ?? []) {
    if (item.at <= before) unread.delete(item.id);
    else read.set(item.id, item);
  }
  for (const item of change.unread ?? []) {
    if (item.at <= before) unread.set(item.id, item);
    else read.delete(item.id);
  }
  return {
    before,
    read: [...read.values()].toSorted(newestFirst).slice(0, activityReadLimits.read),
    unread: [...unread.values()].toSorted(newestFirst).slice(0, activityReadLimits.unread),
    revision: cursor.revision + 1,
  };
}
