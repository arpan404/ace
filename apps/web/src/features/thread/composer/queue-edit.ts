import type { QueuedMessage } from "@ace/protocol";
import { isEmptyDraft, type ComposerDraft, type KeyValueStorage } from "@ace/ui-core";
import { useSyncExternalStore } from "react";
import { Observable } from "@/lib/observable.ts";
import { readDraft } from "./draft-store.ts";
import { replaceOpenDraft, returnDraft, saveOpenDraft } from "./send-store.ts";
import { queuedText } from "./use-queue.ts";

/**
 * A queued message being edited in its thread's composer. Whatever the person had typed there
 * is set aside (`stash`) and comes back once the edit is saved or cancelled.
 */
export interface QueueEditSession {
  message: QueuedMessage;
  stash: ComposerDraft | undefined;
  /** The queue revision its words were read at: saving is fenced to it. */
  revision?: number | undefined;
  /** The message that wasn't sent (the transcript's), not one of the strip's waiting ones. */
  held?: boolean;
  /** What it says now, when another device changed it since; the composer keeps the edit. */
  newer?: string | undefined;
}

const sessions = new Observable<ReadonlyMap<string, QueueEditSession>>(new Map());

const draftKey = (threadId: string) => `thread:${threadId}`;

function set(threadId: string, session: QueueEditSession | undefined): void {
  const next = new Map(sessions.get());
  if (session) next.set(threadId, session);
  else next.delete(threadId);
  sessions.set(next);
}

export function queueEditSession(threadId: string): QueueEditSession | undefined {
  return sessions.get().get(threadId);
}

export function useQueueEdit(threadId: string): QueueEditSession | undefined {
  const read = () => sessions.get().get(threadId);
  return useSyncExternalStore(sessions.subscribe, read, read);
}

/**
 * Edit `message` in the composer: set the composer's draft aside and put the message's words in
 * its place. Editing another message first gives the composer back its own draft. False when the
 * thread's composer isn't open to take it.
 */
export function beginQueueEdit(
  storage: KeyValueStorage | undefined,
  threadId: string,
  message: QueuedMessage,
  /** The revision of the queue page `message` was read from. */
  revision?: number,
  held = false,
): boolean {
  const key = draftKey(threadId);
  const open = queueEditSession(threadId);
  if (!open) saveOpenDraft(key);
  const stash = open ? open.stash : readDraft(storage, key);
  const taken = replaceOpenDraft(key, { text: queuedText(message), mentions: [], attachments: [] });
  if (taken === undefined) return false;
  set(threadId, { message, stash, revision, held });
  return true;
}

/**
 * Another device changed the message being edited: the composer keeps the person's words, the
 * strip shows what it says now, and the next save is fenced to the newer revision, so it replaces
 * that on purpose.
 */
export function markQueueEditChanged(
  threadId: string,
  message: QueuedMessage,
  revision: number,
): void {
  const session = queueEditSession(threadId);
  if (!session) return;
  set(threadId, { ...session, message, revision, newer: queuedText(message) });
}

/** Cancel: the composer shows the draft set aside again, exactly as it was. */
export function cancelQueueEdit(threadId: string): void {
  const session = queueEditSession(threadId);
  if (!session) return;
  set(threadId, undefined);
  replaceOpenDraft(draftKey(threadId), session.stash ?? emptyDraft);
}

/** Saved (or gone): the draft set aside joins whatever the composer holds now. */
export function finishQueueEdit(threadId: string): void {
  const session = queueEditSession(threadId);
  if (!session) return;
  set(threadId, undefined);
  if (session.stash && !isEmptyDraft(session.stash)) returnDraft(draftKey(threadId), session.stash);
}

/**
 * How saving an edit went: saved, refused (try again), changed on another device since it was
 * read (shown, the edit kept), or the message already left the queue.
 */
export type QueueEditOutcome = "saved" | "failed" | "changed" | "gone";

/*
 * The thread's queue strip saves edits through its own queue controls, so the change shows on
 * its pill at once. It registers here while mounted.
 */
type Saver = (
  message: QueuedMessage,
  text: string,
  revision: number | undefined,
) => Promise<QueueEditOutcome>;
const savers = new Map<string, Saver>();

export function registerQueueEditSaver(threadId: string, save: Saver): () => void {
  savers.set(threadId, save);
  return () => {
    if (savers.get(threadId) === save) savers.delete(threadId);
  };
}

/** Save the open edit's new words. */
export async function saveQueueEdit(threadId: string, text: string): Promise<QueueEditOutcome> {
  const session = queueEditSession(threadId);
  const save = savers.get(threadId);
  if (!session) return "gone";
  if (!save) return "failed";
  return save(session.message, text, session.revision);
}

const emptyDraft: ComposerDraft = { text: "", mentions: [], attachments: [] };

/** Test seam. */
export function resetQueueEdits(): void {
  sessions.set(new Map());
  savers.clear();
}
