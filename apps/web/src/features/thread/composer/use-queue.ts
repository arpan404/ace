import { distinctRetainedInputs } from "@ace/projection";
import { inputWithText, tokensFromInput } from "@ace/ui-core";
import { useClient, useThreadMeta } from "@ace/client-react";
import {
  CommandId,
  ThreadId,
  type CommandPayload,
  type QueuePage,
  type QueuedMessage,
} from "@ace/protocol";
import { queueActionPayload, type QueueAction } from "@ace/ui-core";
import { useMemo, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { CommandRefused, failureMessage, runCommand } from "@/lib/daemon-command.ts";
import { useLayout } from "@/lib/layout.tsx";
import { useServerQueue } from "@/lib/server-queue.ts";
import { dismissSend } from "./dismissed-sends.ts";

/** The text of a queued message, as the person wrote it. */
export const queuedText = (message: Pick<QueuedMessage, "input">) =>
  tokensFromInput(message.input).text;

/**
 * A change to one queued message the person made, shown at once while its command is on its
 * way: removed (or sent now), edited, or moved to another place. `revision` is the queue
 * revision it was decided on; once the page is read at a later revision, the page says it.
 */
export type QueueEdit =
  | { kind: "gone"; revision: number; settled: boolean }
  | { kind: "delivering"; revision: number; settled: boolean }
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
  let shown = distinctRetainedInputs(messages).filter(
    (message) => !live.some(([id, edit]) => id === message.id && edit.kind === "gone"),
  );
  shown = shown.map((message) => {
    const edit = live.find(([id, e]) => id === message.id && e.kind === "text")?.[1];
    return edit?.kind === "text"
      ? { ...message, input: inputWithText(message.input, edit.text) }
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
  canSteer: boolean;
  page: QueuePage | undefined;
  /** The page with the person's changes on their way applied. */
  messages: readonly QueuedMessage[];
  /** All saved entries, including those hidden behind Load more. */
  retained: readonly QueuedMessage[];
  /** Every retained entry with this device's optimistic edits applied. */
  allMessages: readonly QueuedMessage[];
  failed: boolean;
  /** A command for this message is on its way: its pill waits for it. */
  busy(messageId: string): boolean;
  /** A queue-wide action (resume, hold, a limit choice) is on its way. */
  acting: boolean;
  refresh(): void;
  loadingMore?: boolean;
  loadMore?(): void;
  remove(message: QueuedMessage): void;
  resend(message: QueuedMessage): void;
  move(index: number, step: -1 | 1): void;
  moveTo(index: number, destination: number): void;
  /** Deliver into the running turn now instead of waiting. */
  sendNow(message: QueuedMessage): void;
  /**
   * New words in place, fenced to the queue revision they were read at (`read`, the page's own
   * when absent): "conflict" when the message changed since, so nothing was overwritten.
   */
  edit(
    message: QueuedMessage,
    text: string,
    read?: number,
  ): Promise<"saved" | "failed" | "conflict">;
  act(action: QueueAction): void;
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
  const canSteer = useThreadMeta(threadId)?.capabilities?.steer === true;
  const toast = useToast();
  const { storage } = useLayout();
  const { page, retained, failed, refresh, loadingMore, loadMore } = useServerQueue(threadId);
  const [edits, setEdits] = useState<ReadonlyMap<string, QueueEdit>>(new Map());
  const [acting, setActing] = useState(false);
  const inFlight = useRef(new Set<string>());
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
    /** A refusal the caller says itself, with no toast. */
    quiet: (error: unknown) => boolean = () => false,
  ) => {
    if (!payload || inFlight.current.has(id)) return false;
    inFlight.current.add(id);
    put(id, edit);
    return runCommand(client, payload, crypto.randomUUID())
      .then(() => {
        // Shown until a page read after this revision lists the result.
        put(id, { ...edit, revision: edit.revision + 1, settled: true });
        return true;
      })
      .catch((error: unknown) => {
        put(id, undefined);
        if (!quiet(error))
          toast.error({ title: `Couldn't ${failure}`, description: failureMessage(error) });
        refresh();
        return false;
      })
      .finally(() => inFlight.current.delete(id));
  };
  const messages = useMemo(
    () => overlayQueue(page?.messages ?? [], edits, revision),
    [page, edits, revision],
  );
  const allMessages = useMemo(
    () => overlayQueue(retained, edits, revision),
    [retained, edits, revision],
  );
  const ids = messages.map((message) => message.id);
  const moveTo = (index: number, destination: number) => {
    const message = messages[index];
    if (!message || index === destination || destination < 0 || destination >= ids.length) return;
    const order = [...ids];
    order.splice(index, 1);
    order.splice(destination, 0, message.id);
    const after = order[destination - 1];
    void change(
      message.id,
      { kind: "order", order, revision, settled: false },
      target && {
        type: "queue.move",
        ...target,
        messageId: message.id,
        after: after === undefined ? null : CommandId.parse(after),
      },
      "move the message",
    );
  };
  return {
    canSteer,
    page,
    messages,
    retained,
    allMessages,
    failed,
    busy: (id) => {
      const edit = edits.get(id);
      return !!edit && !edit.settled;
    },
    acting,
    refresh,
    loadingMore,
    loadMore,
    resend: (message) =>
      void change(
        message.id,
        { kind: "gone", revision, settled: false },
        target && { type: "queue.resend", ...target, messageId: message.id },
        "send the message again",
      ).then(() => refresh()),
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
    move: (index, step) => moveTo(index, index + step),
    moveTo,
    sendNow: (message) => {
      void change(
        message.id,
        { kind: "delivering", revision, settled: false },
        target && {
          type: "queue.edit",
          ...target,
          messageId: message.id,
          input: message.input,
          ...(message.context ? { context: message.context } : {}),
          delivery: "steer",
        },
        "send it now",
      );
    },
    edit: async (message, text, read) => {
      let conflict = false;
      const saved = await change(
        message.id,
        { kind: "text", text, revision, settled: false },
        target && {
          type: "queue.edit",
          ...target,
          ...(read === undefined ? {} : { expectedRevision: read }),
          messageId: message.id,
          input: inputWithText(message.input, text),
          ...(message.context ? { context: message.context } : {}),
        },
        "save the message",
        (error) =>
          (conflict =
            read !== undefined &&
            error instanceof CommandRefused &&
            error.code === "queue_conflict"),
      );
      return saved ? "saved" : conflict ? "conflict" : "failed";
    },
    act: (action) => {
      if (action.id === "choose_model" || inFlight.current.has("queue")) return;
      inFlight.current.add("queue");
      setActing(true);
      void (async () => {
        const { queue } = await client.request({
          type: "queue.get",
          threadId: ThreadId.parse(threadId),
          limit: 1,
        });
        const payload = queueActionPayload(action, ThreadId.parse(threadId), queue);
        if (!payload) return;
        await runCommand(client, payload, crypto.randomUUID());
      })()
        .catch((error: unknown) => {
          toast.error({ title: "Couldn't do that", description: failureMessage(error) });
          refresh();
        })
        .finally(() => {
          inFlight.current.delete("queue");
          setActing(false);
        });
    },
  };
}
