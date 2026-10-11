import type { ClientApi } from "@ace/client";
import { ThreadId, type TurnOptions } from "@ace/protocol";
import type { KeyValueStorage } from "@ace/ui-core";
import type { Draft } from "./draft.ts";
import { rememberAttachments, type StagedSend } from "./send-store.ts";
import { sendWhenUploaded, stage, stagedSends, unstage } from "./staged-sends.ts";

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
  const local = { files: files.files, previews: files.local.map((file) => file.previewUrl) };
  // Nothing uploading: what the daemon holds is known now.
  const ready = files.uploading ? undefined : await files.settled;
  if (!ready || ready.length < files.local.length) {
    stagedSends(request.storage);
    stage(
      {
        ...heldMessage(request),
        attachments: files.local,
      },
      local,
    );
    void sendWhenUploaded(client, commandId, files.outcomes);
    return true;
  }
  rememberAttachments(files.local, ready);
  // The page can close while the worker is still saving. Hold a durable recovery copy
  // before awaiting the outbox, then remove it only after the outbox owns the message.
  stagedSends(request.storage);
  const held = {
    ...heldMessage(request),
    attachments: files.local.map((file, index) =>
      Object.assign({}, file, { sha256: ready[index]?.sha256 }),
    ),
  };
  stage(held, local);
  try {
    await client.enqueue(
      {
        type: "thread.send",
        threadId: ThreadId.parse(threadId),
        input: draft.input ?? [{ type: "text", text: draft.text || "See the attached files." }],
        context: {
          items: draft.threadRefs,
          mentions: draft.mentions,
          attachments: ready.map((file) => ({ sha256: file.sha256 })),
        },
        ...(request.delivery ? { delivery: request.delivery } : {}),
        ...(request.options ? { options: request.options } : {}),
      },
      commandId,
    );
    unstage(commandId, true);
    return true;
  } catch {
    if (
      client
        .pendingSends(threadId)
        .getSnapshot()
        .some((send) => send.commandId === commandId)
    ) {
      // Failed local outbox writes retain only an in-memory record. Keep a reload-safe
      // recovery copy in the existing held-send store until it is saved or edited.
      stage({ ...held, failed: "This device couldn't save the message" }, local);
      request.notify("Message not sent", "Use Retry or Edit on the message to send it again.");
      return true;
    }
    unstage(commandId, true);
    request.notify(
      "Couldn't send the message",
      "This device couldn't save it. It is back in the composer.",
    );
    return false;
  }
}

function heldMessage(request: SendRequest): Omit<StagedSend, "owner" | "attachments"> {
  const { commandId, threadId, draft } = request;
  return {
    commandId,
    threadId,
    text: draft.text,
    mentions: draft.mentions.map((mention) => mention.path),
    input: draft.input,
    context: { mentions: draft.mentions, attachments: [], items: draft.threadRefs },
    ...(request.options ? { options: request.options } : {}),
    ...(request.delivery ? { delivery: request.delivery } : {}),
  };
}
