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
import { useMemo, useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { failureMessage, runCommand } from "@/lib/daemon-command.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useServerQueue } from "@/lib/server-queue.ts";
import { dismissSend } from "./dismissed-sends.ts";

/** The text of a queued message, as the person wrote it. */
export const queuedText = (message: Pick<QueuedMessage, "input">) =>
  message.input.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

/** Replace the text, keep files and images. */
function withText(input: readonly ContentPart[], text: string): ContentPart[] {
  return [{ type: "text", text }, ...input.filter((part) => part.type !== "text")];
}

/**
 * A change to one queued message the person made, shown at once while its command is on its
 * way: removed (or sent now), edited, or moved to another place. `revision` is the queue
 * revision it was decided on; once the page is read at a later revision, the page says it.
 */
export type QueueEdit =
  | { kind: "gone"; revision: number; settled: boolean }
  | { kind: "text"; text: string; revision: number; settled: boolean }
  | { kind: "order"; order: readonly string[]; revision: number; settled: boolean };

/**
 * The queue page as the person sees it: their changes applied over the last page read, until a
 * later page includes them (or a refusal takes them back). Pure.
 */
export function overlayQueue(
  messages: readonly QueuedMessage[],
  edits: ReadonlyMap<string, QueueEdit>,
  revision: number,
): QueuedMessage[] {
  const live = [...edits].filter(([, edit]) => !edit.settled || edit.revision > revision);
  let shown = messages.filter(
    (message) => !live.some(([id, edit]) => id === message.id && edit.kind === "gone"),
  );
  shown = shown.map((message) => {
    const edit = live.find(([id, e]) => id === message.id && e.kind === "text")?.[1];
    return edit?.kind === "text"
      ? { ...message, input: withText(message.input, edit.text) }
      : message;
  });
  const order = live.findLast(([, edit]) => edit.kind === "order")?.[1];
  if (order?.kind === "order") {
    const at = new Map(order.order.map((id, index) => [id, index]));
    shown = shown.toSorted(
      (a, b) =>
        (at.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (at.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
  }
  return shown;
}

export interface QueueControls {
  page: QueuePage | undefined;
  /** The page with the person's changes on their way applied. */
  messages: readonly QueuedMessage[];
  failed: boolean;
  /** A command for this message is on its way: its pill waits for it. */
  busy(messageId: string): boolean;
  /** A queue-wide action (resume, hold, a limit choice) is on its way. */
  acting: boolean;
  refresh(): void;
  remove(message: QueuedMessage): void;
  move(index: number, step: -1 | 1): void;
  /** Deliver into the running turn now instead of waiting. */
  sendNow(message: QueuedMessage): void;
  edit(message: QueuedMessage, text: string): Promise<boolean>;
  act(action: QueueAction["id"]): void;
}

/**
 * The thread's server queue and every command on it (UX audit SY-7). Each change shows at once
 * on its own pill, with that pill waiting for its command; the others stay usable. Commands are
 * durable and carry the revision they were decided on: when another device got there first the
 * daemon answers `queue_conflict`, the change is taken back, the toast says so, and the page is
 * read again.
 */
export function useQueue(threadId: string): QueueControls {
  const client = useClient();
  const toast = useToast();
  const { storage } = useLayout();
  const { page, failed, refresh } = useServerQueue(threadId);
  const [edits, setEdits] = useState<ReadonlyMap<string, QueueEdit>>(new Map());
  const [acting, setActing] = useState(false);
  const revision = page?.revision ?? 0;
  const target = page && {
    threadId: ThreadId.parse(threadId),
    expectedRevision: page.revision,
  };
  const put = (id: string, edit: QueueEdit | undefined) =>
    setEdits((all) => {
      const next = new Map(all);
      if (edit) next.set(id, edit);
      else next.delete(id);
      return next;
    });
  /** Show `edit` on the message now; settle it on the receipt, take it back on a refusal. */
  const change = async (
    id: string,
    edit: QueueEdit,
    payload: CommandPayload | undefined,
    failure: string,
  ) => {
    if (!payload) return false;
    put(id, edit);
    try {
      await runCommand(client, payload, crypto.randomUUID());
      // Shown until a page read after this revision lists the result.
      put(id, { ...edit, revision: edit.revision + 1, settled: true });
      return true;
    } catch (error) {
      put(id, undefined);
      toast.add({ title: `Couldn't ${failure}`, description: failureMessage(error) });
      refresh();
      return false;
    }
  };
  const messages = useMemo(
    () => overlayQueue(page?.messages ?? [], edits, revision),
    [page, edits, revision],
  );
  const ids = messages.map((message) => message.id);
  return {
    page,
    messages,
    failed,
    busy: (id) => {
      const edit = edits.get(id);
      return !!edit && !edit.settled;
    },
    acting,
    refresh,
    remove: (message) =>
      void change(
        message.id,
        { kind: "gone", revision, settled: false },
        target && { type: "queue.remove", ...target, messageId: message.id },
        "remove the message",
      ).then((removed) => {
        // Removed by the person: its message never shows as a bubble either. Only once the
        // daemon has removed it; a refused removal leaves it to be delivered and shown.
        if (removed) dismissSend(storage, message.id);
      }),
    move: (index, step) => {
      const message = messages[index];
      const after = queueMoveAfter(ids, index, step);
      if (!message || after === undefined) return;
      const order = [...ids];
      order.splice(index, 1);
      order.splice(index + step, 0, message.id);
      void change(
        message.id,
        { kind: "order", order, revision, settled: false },
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
      void change(
        message.id,
        { kind: "gone", revision, settled: false },
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
      change(
        message.id,
        { kind: "text", text, revision, settled: false },
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
        action === "resume"
          ? { type: page?.reason === "restart" ? "thread.resume" : "queue.resume", ...target }
          : action === "hold"
            ? { type: "queue.pause", ...target }
            : { type: "thread.limit", ...target, action };
      setActing(true);
      void runCommand(client, payload, crypto.randomUUID())
        .catch((error: unknown) => {
          toast.add({ title: "Couldn't do that", description: failureMessage(error) });
          refresh();
        })
        .finally(() => setActing(false));
    },
  };
}
