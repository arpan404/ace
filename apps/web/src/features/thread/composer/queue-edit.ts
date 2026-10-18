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
): boolean {
  const key = draftKey(threadId);
  const open = queueEditSession(threadId);
  if (!open) saveOpenDraft(key);
  const stash = open ? open.stash : readDraft(storage, key);
  const taken = replaceOpenDraft(key, { text: queuedText(message), mentions: [], attachments: [] });
  if (taken === undefined) return false;
  set(threadId, { message, stash });
  return true;
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

/** How saving an edit went: saved, refused (try again), or the message already left the queue. */
export type QueueEditOutcome = "saved" | "failed" | "gone";

/*
 * The thread's queue strip saves edits through its own queue controls, so the change shows on
 * its pill at once. It registers here while mounted.
 */
const savers = new Map<
  string,
  (message: QueuedMessage, text: string) => Promise<QueueEditOutcome>
>();

export function registerQueueEditSaver(
  threadId: string,
  save: (message: QueuedMessage, text: string) => Promise<QueueEditOutcome>,
): () => void {
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
  return save(session.message, text);
}

const emptyDraft: ComposerDraft = { text: "", mentions: [], attachments: [] };

/** Test seam. */
export function resetQueueEdits(): void {
  sessions.set(new Map());
  savers.clear();
}
