import type { PendingSend, ThreadReader } from "@ace/client";
import { useThread, usePendingSends } from "@ace/client-react";
import type { QueuePage } from "@ace/protocol";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useLayout } from "@/lib/layout.tsx";
import { useServerQueue } from "@/lib/server-queue.ts";
import { dismissedSends, loadDismissed } from "../composer/dismissed-sends.ts";
import {
  interrupted,
  liveOwners,
  pageId,
  stagedSends,
  withPreviews,
  type StagedSend,
} from "../composer/staged-sends.ts";
import type { Block } from "../transcript/blocks.ts";

/*
 * The person's messages on their way, in the transcript (UX audit SY-2, SY-3, SY-7). A message
 * shows as its bubble the moment Enter is pressed, under the key its daemon item will have
 * (`input:<commandId>`), so when the item arrives the same row carries on: no jump, no second
 * bubble, no fade-in replayed. A message still waiting in the thread's queue is a pill above
 * the composer instead, never also a bubble. A daemon notice that a message wasn't delivered is
 * said on that message's bubble ("Not sent"), not as a line of its own.
 */

/** The transcript key of a command's message: the item id the daemon admits it under. */
export const inputItemId = (commandId: string) => `input:${commandId}`;

/** Notices the daemon wrote because a message it accepted couldn't be delivered. */
function readFailures(reader: ThreadReader): ReadonlyMap<string, string> {
  const failures = new Map<string, string>();
  for (const id of reader.order) {
    const item = reader.item(id);
    if (item?.type !== "notice" || !item.code?.startsWith("delivery_")) continue;
    // The daemon names the command on the notice (SY-1); older daemons don't.
    if ("commandId" in item && typeof item.commandId === "string") failures.set(item.commandId, id);
  }
  return failures;
}

function sameFailures(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

const failureKeys = ["order"] as const;

/** Command id → the notice saying its message wasn't delivered. */
export function useDeliveryFailures(threadId: string | undefined): ReadonlyMap<string, string> {
  return useThread(threadId, failureKeys, readFailures, sameFailures) ?? noFailures;
}
const noFailures: ReadonlyMap<string, string> = new Map();

const revisionOf = (reader: ThreadReader) => reader.queue?.revision;

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
    if (send.state === "failed") continue;
    if (send.state === "saving" || send.state === "sent" || !current) queued.add(send.commandId);
  }
  return queued;
}

export function useQueuedCommands(threadId: string): ReadonlySet<string> {
  const pending = usePendingSends(threadId);
  const { page } = useServerQueue(threadId);
  const live = useThread(threadId, ["queue"], revisionOf);
  return useMemo(() => queuedCommands(pending, page, live), [pending, page, live]);
}

/**
 * Messages held for their uploads in this thread, with this page's previews. One held by a
 * page that has since closed (its uploads died with it) reads as failed, with why.
 */
export function useStaged(threadId: string): readonly StagedSend[] {
  const { storage } = useLayout();
  const store = stagedSends(storage);
  const all = useSyncExternalStore(store.subscribe, store.get, store.get);
  const here = useMemo(() => all.filter((send) => send.threadId === threadId), [all, threadId]);
  // Other pages' holds: alive while their pages hold their locks.
  const others = here.some((send) => send.owner !== pageId && !send.failed);
  const [live, setLive] = useState<ReadonlySet<string>>();
  useEffect(() => {
    if (!others) return;
    let current = true;
    void liveOwners().then((owners) => {
      if (current) setLive(owners ?? new Set(here.map((send) => send.owner)));
    });
    return () => {
      current = false;
    };
  }, [others, here]);
  return useMemo(
    () =>
      here.map((send) => {
        const shown = withPreviews(send);
        const gone = send.owner !== pageId && !send.failed && live && !live.has(send.owner);
        return gone ? { ...shown, failed: interrupted(send) } : shown;
      }),
    [here, live],
  );
}

/** Failed sends the person replaced with Retry or took back with Edit. */
export function useDismissedSends(): ReadonlySet<string> {
  const { storage } = useLayout();
  loadDismissed(storage);
  return useSyncExternalStore(dismissedSends.subscribe, dismissedSends.get, dismissedSends.get);
}

export interface LocalSends {
  /** Outbox entries for this thread's sends, oldest first. */
  pending: readonly PendingSend[];
  /** Messages still waiting for their uploads. */
  staged: readonly StagedSend[];
  dismissed: ReadonlySet<string>;
  /** Command ids waiting in the queue: shown as pills, not bubbles. */
  queued: ReadonlySet<string>;
  /** Command id → the daemon's notice that it wasn't delivered. */
  failures: ReadonlyMap<string, string>;
}

/** The command a transcript key was admitted for (`input:<commandId>`). */
export function commandOf(itemId: string): string | undefined {
  return itemId.startsWith("input:") ? itemId.slice("input:".length) : undefined;
}

/**
 * The transcript's blocks with the person's messages on their way: a queued message's bubble
 * leaves (its pill shows it), a delivery-failure notice whose message is on screen leaves (the
 * bubble says it), and a message the daemon hasn't admitted yet is appended as the bubble its
 * item will become. Returns `blocks` itself when nothing changes. Pure.
 */
export function withLocalSends(
  blocks: readonly Block[],
  local: LocalSends,
  /** The items a block shows (`blockItems`, from the transcript). */
  itemsOf: (block: Block) => readonly string[],
): readonly Block[] {
  const shown = new Set<string>();
  for (const block of blocks) for (const id of itemsOf(block)) shown.add(id);
  const failureNotices = new Set<string>();
  for (const [commandId, noticeId] of local.failures)
    if (shown.has(inputItemId(commandId)) || local.dismissed.has(commandId))
      failureNotices.add(noticeId);
  const hidden = (block: Block) => {
    if (block.kind === "item") return failureNotices.has(block.itemId);
    if (block.kind !== "user") return false;
    const commandId = commandOf(block.itemId);
    // Queued: its pill shows it. Dismissed: the person took it back to edit or resent it.
    return (
      commandId !== undefined && (local.queued.has(commandId) || local.dismissed.has(commandId))
    );
  };
  const kept = blocks.some(hidden) ? blocks.filter((block) => !hidden(block)) : blocks;
  const added: Block[] = [];
  const add = (commandId: string) => {
    const itemId = inputItemId(commandId);
    if (shown.has(itemId) || local.queued.has(commandId) || local.dismissed.has(commandId)) return;
    shown.add(itemId);
    added.push({ kind: "user", key: itemId, itemId });
  };
  for (const send of local.pending) add(send.commandId);
  for (const send of local.staged) add(send.commandId);
  return added.length ? [...kept, ...added] : kept;
}
