import type { QueuedMessage } from "@ace/protocol";
import type { HeldQueue } from "./queue-notice.tsx";
import type { QueueControls } from "./use-queue.ts";

/*
 * A send or session start that failed keeps its message at the head of the queue, held as
 * "not sent". The transcript shows that message where it was written, with why and its way out;
 * the composer's strip lists only what is still waiting behind it (owner UI rule: no error prose
 * in the strip). Pure.
 */

/** The message a failed send was kept as, while the queue is held because of it. */
export function failedHead(
  held: HeldQueue | undefined,
  queue: Pick<QueueControls, "messages">,
): QueuedMessage | undefined {
  return held?.notice.kind === "not_sent" ? queue.messages[0] : undefined;
}

/** The queue as the strip lists it: without the message the transcript shows as not sent. */
export function withoutMessage(queue: QueueControls, id: string | undefined): QueueControls {
  if (id === undefined) return queue;
  const keep = (message: QueuedMessage) => message.id !== id;
  const page = queue.page && {
    ...queue.page,
    messages: queue.page.messages.filter(keep),
    total: Math.max(0, queue.page.total - (queue.page.messages.some((m) => m.id === id) ? 1 : 0)),
  };
  return {
    ...queue,
    page,
    messages: queue.messages.filter(keep),
    retained: queue.retained.filter(keep),
    allMessages: queue.allMessages.filter(keep),
  };
}

/** One short sentence for the "Not sent" line; the rest of a longer reason goes to Details. */
export function shortReason(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  const end = trimmed.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? trimmed : trimmed.slice(0, end);
  return sentence.length > 96 ? `${sentence.slice(0, 95).trimEnd()}…` : sentence;
}
