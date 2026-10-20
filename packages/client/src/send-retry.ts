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
  payload: CommandPayload,
): Promise<"resumed" | "resent"> {
  if (payload.type === "thread.send") {
    let after: CommandId | undefined;
    let revision: number | undefined;
    do {
      const { queue } = await client.request({
        type: "queue.get",
        threadId: payload.threadId,
        limit: 32,
        ...(after ? { after, expectedRevision: revision } : {}),
      });
      revision = queue.revision;
      if (queue.messages.some((message) => message.id === commandId)) {
        const result = await client.command({
          type: "queue.resume",
          threadId: payload.threadId,
          expectedRevision: revision,
        });
        if (!result.ok) throw new Error(result.error);
        return "resumed";
      }
      after = queue.next ? CommandId.parse(queue.next) : undefined;
    } while (after);
  }
  await client.enqueue(payload, `${commandId}:retry`);
  return "resent";
}
