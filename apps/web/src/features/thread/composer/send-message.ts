import type { ClientApi } from "@ace/client";
import { ThreadId, type TurnOptions } from "@ace/protocol";
import type { KeyValueStorage } from "@ace/ui-core";
import type { Draft } from "./draft.ts";
import { rememberAttachments } from "./send-store.ts";
import { sendWhenUploaded, stage, stagedSends } from "./staged-sends.ts";

/*
 * Sending one message from the thread's composer (UX audit SY-2, AT-2). Loaded with the
 * composer's deferred parts, so the route's first paint doesn't carry it.
 */

export interface SendRequest {
  client: ClientApi;
  storage: KeyValueStorage | undefined;
  threadId: string;
  commandId: string;
  draft: Draft;
  delivery: "steer" | "queue" | undefined;
  options: TurnOptions | undefined;
  notify(title: string, description: string): void;
}

/**
 * Enqueue the message under `commandId`. Files still uploading (or one that didn't) hold it as
 * its bubble, kept on this device until they're done; it then goes under the same id, so the
 * held bubble carries on as the outbox entry, and a failed upload leaves the bubble with Retry
 * and Edit. Resolves false only when this device couldn't save it: the composer gives it back.
 */
export async function sendMessage(request: SendRequest): Promise<boolean> {
  const { client, threadId, commandId, draft } = request;
  const { files } = draft;
  // Nothing uploading: what the daemon holds is known now.
  const ready = files.uploading ? undefined : await files.settled;
  if (!ready || ready.length < files.local.length) {
    stagedSends(request.storage);
    stage(
      {
        commandId,
        threadId,
        text: draft.text,
        mentions: draft.mentions.map((mention) => mention.path),
        attachments: files.local,
        ...(request.options ? { options: request.options } : {}),
        ...(request.delivery ? { delivery: request.delivery } : {}),
      },
      { files: files.files, previews: files.local.map((file) => file.previewUrl) },
    );
    void sendWhenUploaded(client, commandId, files.outcomes);
    return true;
  }
  rememberAttachments(files.local, ready);
  try {
    await client.enqueue(
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
    return true;
  } catch {
    request.notify(
      "Couldn't send the message",
      "This device couldn't save it. It is back in the composer.",
    );
    return false;
  }
}
