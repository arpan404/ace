import { retryOf } from "./send-ops.ts";
import { CommandId, type CommandPayload } from "@ace/protocol";
import type { ClientApi } from "./api.ts";

/**
 * A failed send goes again exactly once. A message the daemon's queue still holds (a queue
 * paused by the failure) is resumed in place, so it never runs twice; anything else is enqueued
 * again under `<commandId>:retry`, its own durable command. Rejects when neither could be done.
 */
export async function retrySend(
  client: Pick<ClientApi, "request" | "command" | "enqueue">,
  commandId: string,
  /**
   * The send, or how to read it: a function is read at the moment the retry is saved, so an edit
   * made while the queue was being checked is the one that goes.
   */
  payload: CommandPayload | (() => CommandPayload | undefined),
): Promise<"resumed" | "resent"> {
  const read = () => (typeof payload === "function" ? payload() : payload);
  const initial = read();
  if (!initial) throw new Error("not_found");
  if (initial.type === "thread.send") {
    let after: CommandId | undefined;
    let revision: number | undefined;
    do {
      const { queue } = await client.request({
        type: "queue.get",
        threadId: initial.threadId,
        limit: 32,
        ...(after ? { after, expectedRevision: revision } : {}),
      });
      revision = queue.revision;
      if (queue.messages.some((message) => message.id === commandId)) {
        const result = await client.command({
          type: "queue.resume",
          threadId: initial.threadId,
          expectedRevision: revision,
        });
        if (!result.ok) throw new Error(result.error);
        return "resumed";
      }
      after = queue.next ? CommandId.parse(queue.next) : undefined;
    } while (after);
  }
  const current = read();
  if (!current) throw new Error("not_found");
  await client.enqueue(current, retryOf(commandId));
  return "resent";
}
