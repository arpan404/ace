import type { ClientApi } from "@ace/client";
import { ThreadId, type TurnOptions } from "@ace/protocol";
import type { Draft } from "./draft.ts";
import { rememberAttachments, stage, unstage } from "./send-store.ts";

/*
 * Sending one message from the thread's composer (UX audit SY-2, AT-2). Loaded with the
 * composer's deferred parts, so the route's first paint doesn't carry it.
 */

export interface SendRequest {
  client: ClientApi;
  threadId: string;
  commandId: string;
  draft: Draft;
  delivery: "steer" | "queue" | undefined;
  options: TurnOptions | undefined;
  notify(title: string, description: string): void;
}

/**
 * Enqueue the message under `commandId`. Files still uploading hold it as its bubble
 * ("Uploading 2 images…") until they're done; it then goes under the same id, so the held
 * bubble carries on as the outbox entry. Resolves false, with a note, when it can't go: a file
 * didn't upload, or this device couldn't save it. The composer then gives the message back.
 */
export async function sendMessage(request: SendRequest): Promise<boolean> {
  const { client, threadId, commandId, draft } = request;
  const { files } = draft;
  if (files.uploading)
    stage({
      commandId,
      threadId,
      text: draft.text,
      attachments: files.local,
      uploading: files.uploading,
    });
  const ready = await files.settled;
  rememberAttachments(files.local, ready);
  if (ready.length < files.local.length) {
    unstage(threadId, commandId);
    request.notify("A file didn't upload", "The message is back in the composer without it.");
    return false;
  }
  try {
    const saved = client.enqueue(
      {
        type: "thread.send",
        threadId: ThreadId.parse(threadId),
        input: [{ type: "text", text: draft.text || "See the attached files." }],
        context: {
          mentions: draft.mentions,
          attachments: ready.map((file) => ({ sha256: file.sha256 })),
        },
        ...(request.delivery ? { delivery: request.delivery } : {}),
        ...(request.options ? { options: request.options } : {}),
      },
      commandId,
    );
    // The outbox shows it at once under the same key, so the held bubble carries on.
    unstage(threadId, commandId);
    await saved;
    return true;
  } catch {
    unstage(threadId, commandId);
    request.notify(
      "Couldn't send the message",
      "This device couldn't save it. It is back in the composer.",
    );
    return false;
  }
}
