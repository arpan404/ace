import { readServerQueue, type ClientCore } from "@ace/client";
import { CommandId, type QueuedMessage, type ThreadId } from "@ace/protocol";
import { tokensFromInput } from "@ace/ui-core";
import { submitCommand } from "./commands.ts";
import type { TakeBackLedger } from "./take-back-ledger.ts";

/*
 * Words taken back from a message that wasn't sent, for the composer. The words are the canonical
 * message's, read from the daemon's queue at that moment, never a display preview. A queued
 * message is removed first and its words handed back only once the daemon's receipt says it is
 * gone: a refusal (another device moved the queue) leaves the original where it was and the
 * composer as it was, so nothing is ever queued twice. Before the removal, the words are kept in
 * a take-back record (`take-back-ledger.ts`) until the phone has them in its draft, so a runtime
 * that stops in between loses nothing.
 */

export interface TakenBack {
  ok: boolean;
  /** The full words, when `ok`. */
  text: string | null;
  /** Why not, when not. */
  message: string;
  /** The take-back record to acknowledge once the words are in the draft. */
  record?: string | undefined;
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
): Promise<TakenBack> {
  try {
    const found = await canonical(client, threadId, messageId, signal);
    return found
      ? { ok: true, text: queuedWords(found.message), message: "" }
      : { ok: false, text: null, message: changed };
  } catch {
    return { ok: false, text: null, message: "Couldn't reach your computer. Try again." };
  }
}

/**
 * Remove the message on the daemon, then hand back its full words. A message with files is never
 * taken back this way: its words are changed where it waits, so its files stay with it.
 */
export async function takeBackQueued(
  client: Pick<ClientCore, "request" | "commandId" | "intent" | "enqueue">,
  threadId: ThreadId,
  messageId: string,
  signal: AbortSignal,
  ledger: TakeBackLedger,
): Promise<TakenBack> {
  let found: Awaited<ReturnType<typeof canonical>>;
  try {
    found = await canonical(client, threadId, messageId, signal);
  } catch {
    return { ok: false, text: null, message: "Couldn't reach your computer. Try again." };
  }
  if (!found) return { ok: false, text: null, message: changed };
  if (queuedFiles(found.message) > 0)
    return { ok: false, text: null, message: "Its files stay with it: change its words instead." };
  const text = queuedWords(found.message);
  const record = client.commandId();
  const removal = client.commandId();
  const kept = await ledger.record({
    id: record,
    threadId,
    text,
    kind: "queue",
    source: messageId,
    removal,
  });
  if (!kept)
    return { ok: false, text: null, message: "Couldn't save that on this phone. Try again." };
  const refused = async (message: string): Promise<TakenBack> => {
    await ledger.settle(record);
    return { ok: false, text: null, message };
  };
  const payload = {
    type: "queue.remove" as const,
    threadId,
    expectedRevision: found.revision,
    messageId: CommandId.parse(messageId),
  };
  return new Promise<TakenBack>((resolve) => {
    submitCommand(
      client,
      payload,
      () => {},
      (result) =>
        resolve(
          result.ok
            ? { ok: true, text, message: "", record }
            : refused(
                result.error === "queue_conflict" ? changed : "Your computer kept the message.",
              ),
        ),
      removal,
    ).catch(() => resolve(refused("Couldn't save that on this phone. Try again.")));
  });
}
