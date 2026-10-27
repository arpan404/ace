import { readServerQueue, type ClientCore } from "@ace/client";
import type { QueuedMessage, ThreadId } from "@ace/protocol";
import { tokensFromInput } from "@ace/ui-core";

/*
 * A queued message's full words for the edit sheet: read from the daemon's queue at that moment,
 * never the transcript's shortened preview. Editing changes them where the message waits
 * (`queue.edit`); nothing is ever removed in order to edit it.
 */

export interface FullWords {
  ok: boolean;
  /** The full words, when `ok`. */
  text: string | null;
  /** Why not, when not. */
  message: string;
  /** The queue revision the words were read at: an edit of them is fenced to it. */
  revision?: number | null;
}

const changed = "That message has changed. Check the queue and try again.";

/** The message's words as the person wrote them, mentions as their `@` words. */
export const queuedWords = (message: Pick<QueuedMessage, "input">) =>
  tokensFromInput(message.input).text;

/** Files and images on a queued message: its own parts and the uploads its context holds. */
export const queuedFiles = (message: Pick<QueuedMessage, "input" | "context">) =>
  message.input.filter((part) => part.type !== "text" && part.type !== "mention").length +
  (message.context?.attachments?.length ?? 0);

/** The canonical message and the revision it was read at, or undefined once it is gone. */
async function canonical(
  client: Pick<ClientCore, "request">,
  threadId: ThreadId,
  messageId: string,
  signal: AbortSignal,
): Promise<{ message: QueuedMessage; revision: number } | undefined> {
  const page = await readServerQueue(
    threadId,
    async (request) => (await client.request({ type: "queue.get", ...request }, { signal })).queue,
  );
  const message = page.messages.find((entry) => entry.id === messageId);
  return message && { message, revision: page.revision };
}

/** The message's full words, without changing it (to edit them where it waits). */
export async function readQueuedWords(
  client: Pick<ClientCore, "request">,
  threadId: ThreadId,
  messageId: string,
  signal: AbortSignal,
): Promise<FullWords> {
  try {
    const found = await canonical(client, threadId, messageId, signal);
    return found
      ? { ok: true, text: queuedWords(found.message), message: "", revision: found.revision }
      : { ok: false, text: null, message: changed };
  } catch {
    return { ok: false, text: null, message: "Couldn't reach your computer. Try again." };
  }
}
