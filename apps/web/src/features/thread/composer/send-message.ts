import type { ClientApi } from "@ace/client";
import { type TurnOptions } from "@ace/protocol";
import type { KeyValueStorage } from "@ace/ui-core";
import type { Draft } from "./draft.ts";
import { type StagedSend } from "./send-store.ts";
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
  const { client, commandId, draft } = request;
  const { files } = draft;
  const local = { files: files.files, previews: files.local.map((file) => file.previewUrl) };
  stagedSends(request.storage);
  // Reserve the submission's place before waiting for any upload or asynchronous outbox write.
  if (!stage({ ...heldMessage(request), attachments: files.local, preparing: true }, local))
    return refuseStage(request);
  void sendWhenUploaded(client, commandId, files.outcomes);
  return true;
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

function refuseStage(request: SendRequest): false {
  request.notify(
    "Message not sent",
    "This device couldn't save the message. Keep your draft, check device storage or retry the messages waiting to send, then try again.",
  );
  return false;
}
