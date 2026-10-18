import type { PendingSend, ThreadKey, ThreadReader } from "@ace/client";
import { arrayEqual, useThread, usePendingSends, useClient } from "@ace/client-react";
import type { QueuePage } from "@ace/protocol";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useLayout } from "@/lib/layout.tsx";
import { useSeconds } from "@/lib/time.ts";
import { useServerQueue } from "@/lib/server-queue.ts";
import { dismissedSends, loadDismissed } from "../composer/dismissed-sends.ts";
import {
  drainStaged,
  isInterrupted,
  stagedSends,
  unstage,
  withPreviews,
  type StagedSend,
} from "../composer/staged-sends.ts";
import { uploadPending } from "../composer/upload-interruption.ts";

/*
 * The person's messages on their way, as this window knows them: which are waiting in the
 * thread's queue, which are held for their uploads, and which the person dismissed. The
 * transcript never draws them (it shows only the daemon's items); the composer's strip does.
 */

/** The transcript key of a command's message: the item id the daemon admits it under. */
export const inputItemId = (commandId: string) => `input:${commandId}`;

const revisionOf = (reader: ThreadReader) => reader.queue?.revision;
const sameAdmitted = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  a === b || (!!a && !!b && arrayEqual(a, b));

/**
 * Command ids of messages still waiting in the thread's queue: those on the queue page read at
 * the live revision, and queued sends the page can't show yet (still saving, or accepted while
 * the page is being read again).
 */
export function queuedCommands(
  pending: readonly PendingSend[],
  page: Pick<QueuePage, "revision" | "messages"> | undefined,
  liveRevision: number | undefined,
): ReadonlySet<string> {
  const queued = new Set<string>(page?.messages.map((message) => message.id));
  const current = !!page && page.revision === liveRevision;
  for (const send of pending) {
    if (send.payload.type !== "thread.send" || send.payload.delivery !== "queue") continue;
    // Failed: the strip shows it. Delivered: its item is in the transcript, so it left the queue.
    if (send.state === "failed" || send.state === "delivered") continue;
    if (send.state === "saving" || send.state === "sent" || !current) queued.add(send.commandId);
  }
  return queued;
}

export function useQueuedCommands(threadId: string): ReadonlySet<string> {
  const pending = usePendingSends(threadId);
  const { page, retained } = useServerQueue(threadId);
  const live = useThread(threadId, ["queue"], revisionOf);
  return useMemo(
    () =>
      queuedCommands(
        pending,
        page ? { revision: page.revision, messages: [...retained] } : undefined,
        live,
      ),
    [pending, page, retained, live],
  );
}

/**
 * Messages held for their uploads in this thread, with this page's previews. One held by a
 * page that has since closed (its uploads died with it) reads as failed, with why.
 */
export function useStaged(threadId: string): readonly StagedSend[] {
  const client = useClient();
  const { storage } = useLayout();
  const store = stagedSends(storage);
  const all = useSyncExternalStore(store.subscribe, store.get, store.get);
  const here = useMemo(() => all.filter((send) => send.threadId === threadId), [all, threadId]);
  const pending = usePendingSends(threadId);
  const outbox = useMemo(
    () => new Map(pending.map((send) => [send.commandId, send.state])),
    [pending],
  );
  // Undefined until the thread has loaded: only then can the transcript say it owns a send.
  const readAdmitted = useCallback(
    (reader: ThreadReader) =>
      reader.thread
        ? here
            .filter((send) => reader.item(inputItemId(send.commandId))?.type === "message")
            .map((send) => send.commandId)
        : undefined,
    [here],
  );
  const admitted = useThread(
    threadId,
    ["thread", ...here.map((send): ThreadKey => `item:${inputItemId(send.commandId)}`)],
    readAdmitted,
    sameAdmitted,
  );
  const owned = useMemo(() => new Set(admitted), [admitted]);
  useEffect(() => {
    for (const send of here) {
      const state = outbox.get(send.commandId);
      if (owned.has(send.commandId) || (state && state !== "saving" && state !== "failed"))
        unstage(send.commandId, true);
    }
  }, [here, outbox, owned]);
  const loaded = admitted !== undefined;
  useEffect(() => {
    // A copy left from before a reload may already be in the transcript: wait to know.
    if (!loaded) return;
    if (!here.some((send) => !owned.has(send.commandId) && outbox.get(send.commandId) !== "saving"))
      return;
    void drainStaged(client, threadId);
  }, [client, threadId, here, outbox, owned, loaded]);
  const now = useSeconds(here.some(uploadPending));
  return useMemo(
    () =>
      here
        .filter(
          (send) =>
            !owned.has(send.commandId) &&
            (!outbox.has(send.commandId) || outbox.get(send.commandId) === "failed"),
        )
        .map((send, index) => {
          const shown = Object.assign({}, withPreviews(send), { waitingForEarlier: index > 0 });
          return Object.assign({}, shown, { uploadInterrupted: isInterrupted(send, now) });
        }),
    [here, outbox, owned, now],
  );
}

/** Failed sends the person replaced with Retry or took back with Edit. */
export function useDismissedSends(): ReadonlySet<string> {
  const { storage } = useLayout();
  loadDismissed(storage);
  return useSyncExternalStore(dismissedSends.subscribe, dismissedSends.get, dismissedSends.get);
}
