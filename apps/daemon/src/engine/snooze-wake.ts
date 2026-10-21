import { queueWakesSnooze } from "@ace/projection";
import type { EventPayload, Thread, ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";

/** The wake to publish before a queue change that newly needs the person on a snoozed thread. */
export function wakeFor(
  store: Store,
  id: ThreadId,
  next: NonNullable<Thread["queue"]>,
  at: number,
): EventPayload[] {
  const thread = store.getThread(id);
  return thread && queueWakesSnooze(thread, next, at)
    ? [{ type: "thread.client.updated", changes: { snoozedUntil: null } }]
    : [];
}
