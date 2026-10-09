import type { Thread } from "@ace/protocol";

/** Recovery needs a person even when the previous turn completed successfully. */
export function threadAttention(thread: Pick<Thread, "queue">): string | undefined {
  const queue = thread.queue;
  if (!queue?.paused || !queue.reason || queue.resumeAt !== null) return undefined;
  if (queue.reason === "manual" && !queue.pendingCount) return undefined;
  if (queue.reason === "limit" || queue.reason === "snooze") return undefined;
  return queue.reason;
}
