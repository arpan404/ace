import { z } from "zod";

/*
 * Activity read state, kept by the daemon so it survives reloads and follows the person to
 * every device (unlike a thread's per-device `thread.readState`). One cursor per host: every
 * feed item at or before `before` is read unless it was marked unread again, and items after
 * it are read only when listed. Items are named by the client's feed ids ("ci:…", "run-…").
 */

const requestId = z.string().min(1).max(128);
const instant = z.number().int().min(0).max(8_640_000_000_000_000);
export const ActivityItemRef = z.object({
  id: z.string().min(1).max(512),
  /** When the item happened; decides whether `before` already covers it. */
  at: instant,
});
export type ActivityItemRef = z.infer<typeof ActivityItemRef>;

/** Read marks kept after `before`, and unread marks kept at or before it. Newest kept. */
export const activityReadLimits = { read: 2000, unread: 500, change: 500 } as const;

export const ActivityReadCursor = z.object({
  /** Every item at or before this instant is read, except those in `unread`. */
  before: instant,
  /** Items after `before` that were read. */
  read: z.array(ActivityItemRef).max(activityReadLimits.read),
  /** Items at or before `before` marked unread again. */
  unread: z.array(ActivityItemRef).max(activityReadLimits.unread),
  /** Grows with every change, so a client can drop a reply older than a push it already has. */
  revision: z.number().int().nonnegative(),
});
export type ActivityReadCursor = z.infer<typeof ActivityReadCursor>;

/** Read the cursor. The first read on a host starts it at that moment: older items count read. */
export const ActivityReadsGet = z.object({ type: z.literal("activity.reads"), requestId });
/** Mark items read or unread, or everything up to an instant read. Merged, never replaced. */
export const ActivityMarkRead = z.object({
  type: z.literal("activity.markRead"),
  requestId,
  read: z.array(ActivityItemRef).max(activityReadLimits.change).optional(),
  unread: z.array(ActivityItemRef).max(activityReadLimits.change).optional(),
  /** Everything at or before this instant is read (Mark all read). */
  allBefore: instant.optional(),
});
export const ActivityReadsRequest = z.discriminatedUnion("type", [
  ActivityReadsGet,
  ActivityMarkRead,
]);
export type ActivityReadsRequest = z.infer<typeof ActivityReadsRequest>;
export const ActivityReadsResult = z.object({
  type: z.literal("activity.reads.result"),
  requestId,
  cursor: ActivityReadCursor,
});
export type ActivityReadsResult = z.infer<typeof ActivityReadsResult>;
/** Pushed to every connected device after a change, the writer included. */
export const ActivityReadsChanged = z.object({
  type: z.literal("activity.reads.changed"),
  cursor: ActivityReadCursor,
});
export type ActivityReadsChanged = z.infer<typeof ActivityReadsChanged>;

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
  change: {
    read?: readonly ActivityItemRef[];
    unread?: readonly ActivityItemRef[];
    allBefore?: number;
  },
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
