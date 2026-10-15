import type { QueueSnapshot, ThreadStatus } from "@ace/protocol";

/** The Summary's one line about input still waiting to reach the agent. */
export interface QueuedInputLine {
  /** Messages still queued; 0 when the daemon says the thread waits on its queue but has no count yet. */
  count: number;
  /** "1 queued message", "3 queued messages", or "Queued messages" without a count. */
  label: string;
  /** When they go: "sends when the agent is free" only while that is true. */
  when: string;
}

/**
 * What the Summary says about queued input, or undefined when there is none to show. A message
 * whose send or session start failed is the transcript's inline failed item (Not sent · Try
 * again / Edit / Remove); the daemon keeps it at the head of a held queue, but it is not queued
 * work, so it is not counted here. Nothing reads "sends when the agent is free" while the queue
 * is held or the agent has failed: a failed agent is not about to be free.
 */
export function queuedInputLine(input: {
  /** Messages the daemon retains for the thread, including a held head that wasn't sent. */
  retained: number;
  queue: Pick<QueueSnapshot, "paused" | "reason"> | undefined;
  status: ThreadStatus | undefined;
  agentFailed: boolean;
}): QueuedInputLine | undefined {
  const reason = input.queue?.paused ? input.queue.reason : null;
  const notSent = reason === "not_sent";
  const count = Math.max(0, input.retained - (notSent ? 1 : 0));
  const waiting = !notSent && input.status?.state === "waiting" && input.status.on === "queue";
  if (count === 0 && !waiting) return undefined;
  const label =
    count > 1 ? `${count} queued messages` : count === 1 ? "1 queued message" : "Queued messages";
  const one = count === 1;
  const when = notSent
    ? `${one ? "waits" : "wait"} for the message that wasn't sent`
    : reason !== null
      ? "held until you continue"
      : input.agentFailed || input.status?.state === "failed"
        ? "not sent yet"
        : `${one ? "sends" : "send"} when the agent is free`;
  return { count, label, when };
}
