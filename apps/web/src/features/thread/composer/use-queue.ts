import { useClient } from "@ace/client-react";
import {
  CommandId,
  ThreadId,
  type CommandPayload,
  type ContentPart,
  type QueuePage,
  type QueuedMessage,
} from "@ace/protocol";
import { queueMoveAfter, type QueueAction } from "@ace/ui-core";
import { useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { failureMessage, runCommand } from "@/lib/daemon-command.ts";
import { useServerQueue } from "@/lib/server-queue.ts";

/** The text of a queued message, as the person wrote it. */
export const queuedText = (message: QueuedMessage) =>
  message.input.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

/** Replace the text, keep files and images. */
function withText(input: readonly ContentPart[], text: string): ContentPart[] {
  return [{ type: "text", text }, ...input.filter((part) => part.type !== "text")];
}

export interface QueueControls {
  page: QueuePage | undefined;
  failed: boolean;
  /** A command is on its way; controls wait for it. */
  busy: boolean;
  refresh(): void;
  remove(message: QueuedMessage): void;
  move(index: number, step: -1 | 1): void;
  /** Deliver into the running turn now instead of waiting. */
  sendNow(message: QueuedMessage): void;
  edit(message: QueuedMessage, text: string): Promise<boolean>;
  act(action: QueueAction): void;
}

/**
 * The thread's server queue and every command on it. Each carries the revision it was decided
 * on; when another device got there first the daemon answers `queue_conflict`, the toast says
 * so, and the page is read again.
 */
export function useQueue(threadId: string): QueueControls {
  const client = useClient();
  const toast = useToast();
  const { page, failed, refresh } = useServerQueue(threadId);
  const [busy, setBusy] = useState(false);
  const target = page && {
    threadId: ThreadId.parse(threadId),
    expectedRevision: page.revision,
  };
  const run = async (payload: CommandPayload | undefined, failure: string) => {
    if (!payload) return false;
    setBusy(true);
    try {
      await runCommand(client, payload);
      return true;
    } catch (error) {
      toast.add({ title: `Couldn't ${failure}`, description: failureMessage(error) });
      refresh();
      return false;
    } finally {
      setBusy(false);
    }
  };
  const ids = page?.messages.map((message) => message.id) ?? [];
  return {
    page,
    failed,
    busy,
    refresh,
    remove: (message) =>
      void run(
        target && { type: "queue.remove", ...target, messageId: message.id },
        "remove the message",
      ),
    move: (index, step) => {
      const message = page?.messages[index];
      const after = queueMoveAfter(ids, index, step);
      if (!message || after === undefined) return;
      void run(
        target && {
          type: "queue.move",
          ...target,
          messageId: message.id,
          after: after === null ? null : CommandId.parse(after),
        },
        "move the message",
      );
    },
    sendNow: (message) =>
      void run(
        target && {
          type: "queue.edit",
          ...target,
          messageId: message.id,
          input: message.input,
          ...(message.context ? { context: message.context } : {}),
          delivery: "steer",
        },
        "send it now",
      ),
    edit: (message, text) =>
      run(
        target && {
          type: "queue.edit",
          ...target,
          messageId: message.id,
          input: withText(message.input, text),
          ...(message.context ? { context: message.context } : {}),
        },
        "save the message",
      ),
    act: (action) => {
      if (!target) return;
      const payload: CommandPayload =
        action.id === "resume"
          ? { type: page?.reason === "restart" ? "thread.resume" : "queue.resume", ...target }
          : action.id === "hold"
            ? { type: "queue.pause", ...target }
            : {
                type: "thread.limit",
                ...target,
                action: action.id,
                ...("instanceId" in action && action.instanceId
                  ? { instanceId: action.instanceId }
                  : {}),
              };
      void run(payload, "do that");
    },
  };
}
