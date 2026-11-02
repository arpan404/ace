import type { Thread } from "@ace/protocol";

type QueueState = NonNullable<Thread["queue"]>;

/**
 * Recovery needs a person even when the previous turn completed successfully. The person's own
 * Stop asks nothing of them: the turn is done and already seen (ADR 0052), so it is never
 * attention, with or without the messages it kept.
 */
export function threadAttention(thread: Pick<Thread, "queue">): string | undefined {
  const queue = thread.queue;
  if (!queue?.paused || !queue.reason || queue.resumeAt !== null) return undefined;
  if (queue.reason === "manual" && !queue.pendingCount) return undefined;
  if (queue.reason === "limit" || queue.reason === "snooze" || queue.reason === "stopped")
    return undefined;
  return queue.reason;
}

/** The person's own Stop ended the thread's latest turn, and nothing has run since. */
export function stoppedByPerson(thread: {
  queue?: Pick<QueueState, "paused" | "reason"> | undefined;
}): boolean {
  return thread.queue?.paused === true && thread.queue.reason === "stopped";
}

/**
 * Whether a snoozed thread wakes as its queue changes to `next`: only for recovery that newly
 * needs the person. A snooze set while the thread already needed recovery is the person's
 * choice, so the same hold carrying on keeps it asleep.
 */
export function queueWakesSnooze(
  thread: Pick<Thread, "queue" | "snoozedUntil">,
  next: QueueState,
  at: number,
): boolean {
  if (thread.snoozedUntil === undefined || thread.snoozedUntil <= at) return false;
  const after = threadAttention({ queue: next });
  return after !== undefined && after !== threadAttention(thread);
}
