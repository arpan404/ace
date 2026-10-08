/*
 * What this window knows about messages on their way that the client's outbox doesn't (UX audit
 * SY-2, SY-3): a message still waiting for its files to upload before it can be enqueued, the
 * local previews of the images it carries, failed sends the person dismissed (Retry or Edit
 * replaced them), and which composer takes a failed message back for editing. The outbox itself
 * (`usePendingSends`) owns everything that was enqueued.
 */

import type { PendingSend } from "@ace/client";
import { useSyncExternalStore } from "react";
import type { LocalAttachment } from "@/components/attachment-format.ts";
import type { Block } from "../transcript/blocks.ts";
import { tokensFromInput, type ComposerToken } from "@ace/ui-core";
import type { ContentPart, MessageContext, TurnOptions } from "@ace/protocol";

/**
 * A message held back until its files upload (`staged-sends.ts` keeps them): its files with this
 * page's previews where it has them, and why it can't go as it is, once it can't.
 */
export interface StagedSend {
  commandId: string;
  threadId: string;
  text: string;
  mentions: string[];
  input?: ContentPart[] | undefined;
  context?: MessageContext | undefined;
  attachments: (LocalAttachment & { sha256?: string | undefined })[];
  options?: TurnOptions | undefined;
  delivery?: "steer" | "queue" | undefined;
  /** The page uploading its files; another page can't finish them. */
  owner: string;
  /** Why it can't go as it is, in words; undefined while its files upload. */
  failed?: string | undefined;
}

type Listener = () => void;

/** A tiny observable value, read through `useSyncExternalStore`. */
export class Observable<T> {
  private listeners = new Set<Listener>();
  private value: T;
  constructor(value: T) {
    this.value = value;
  }
  get = (): T => this.value;
  /** Set without telling anyone: for a value loaded lazily during a render. */
  seed(value: T): void {
    this.value = value;
  }
  set(value: T): void {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

/*
 * Local attachment details by content hash: names and previews for a message the daemon hasn't
 * echoed yet. This store owns the previews from here on; bounded, the oldest go first.
 */
const localLimit = 64;
const locals = new Map<string, LocalAttachment>();

/**
 * Remember the files a message carries (`local`, as the composer handed them over) under the
 * hashes the daemon gave them (`ready`, in the same order, failed ones left out).
 */
export function rememberAttachments(
  local: readonly LocalAttachment[],
  ready: readonly { sha256: string; name: string }[],
): void {
  const unmatched = [...local];
  for (const file of ready) {
    const at = unmatched.findIndex((candidate) => candidate.name === file.name);
    const attachment = at < 0 ? undefined : unmatched.splice(at, 1)[0];
    if (!attachment) continue;
    const old = locals.get(file.sha256);
    if (old?.previewUrl && old.previewUrl !== attachment.previewUrl)
      URL.revokeObjectURL(old.previewUrl);
    locals.delete(file.sha256);
    locals.set(file.sha256, attachment);
  }
  while (locals.size > localLimit) {
    const [oldest] = locals.keys();
    if (oldest === undefined) break;
    const gone = locals.get(oldest);
    if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
    locals.delete(oldest);
  }
}

export function localAttachment(sha256: string): LocalAttachment | undefined {
  return locals.get(sha256);
}

/** A message given back to the composer: what Edit restores. */
export interface ReturnedDraft {
  text: string;
  mentions: readonly string[];
  tokens?: readonly ComposerToken[] | undefined;
  attachments: readonly { sha256: string; name: string }[];
  options?: import("@ace/protocol").TurnOptions | undefined;
}

/*
 * Composers that take a failed message back, by draft key. The thread's composer registers
 * while mounted; Edit on a failed bubble hands its draft to the one for that thread.
 */
const takers = new Map<string, (draft: ReturnedDraft) => void>();

export function takeDraftsFor(key: string, take: (draft: ReturnedDraft) => void): () => void {
  takers.set(key, take);
  return () => {
    if (takers.get(key) === take) takers.delete(key);
  };
}

/** Hand a draft to the composer under `key`; false when none is mounted there. */
export function returnDraft(key: string, draft: ReturnedDraft): boolean {
  const take = takers.get(key);
  if (!take) return false;
  take(draft);
  return true;
}

/** The text a message carries, as written. */
export function inputText(input: readonly ContentPart[]): string {
  return tokensFromInput(input).text;
}

/*
 * Provisional titles of threads this window started (UX audit TN-1), by their create command:
 * New thread works them out as it sends, so the thread's header and its row read them at once.
 */
const titles = new Map<string, string>();

export function rememberTitle(commandId: string, title: string): void {
  titles.set(commandId, title);
  if (titles.size > 64) titles.delete(titles.keys().next().value ?? "");
}

export function startedTitle(commandId: string): string | undefined {
  return titles.get(commandId);
}

/** Test seam: forget everything this window held. */
export function resetSendStore(): void {
  for (const attachment of locals.values())
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  locals.clear();
  takers.clear();
  titles.clear();
}

/**
 * A thread started from this window that the daemon hasn't named yet is shown under
 * `pending:<commandId>` (its `thread.create` command). Such an id is never leased from the
 * daemon: there's nothing there to subscribe to until the receipt names the real thread.
 */
export function isPendingThread(threadId: string | undefined): boolean {
  return threadId?.startsWith("pending:") === true;
}

/** The daemon's thread id, or undefined for a pending one (nothing to lease yet). */
export function leasable(threadId: string): string | undefined {
  return isPendingThread(threadId) ? undefined : threadId;
}

/*
 * The person's messages on their way, as the transcript reads them (UX audit SY-2, SY-3): how to
 * merge them into the blocks and what each bubble has to say. The logic loads with the thread's
 * deferred parts (`LocalSends` publishes a view here per thread), so the route's first paint
 * carries only this slot; until it arrives the transcript shows the daemon's items as they are.
 */

/** What a bubble knows of its message's way to the daemon. */

export interface LocalSend {
  send?: PendingSend | undefined;
  staged?: StagedSend | undefined;
  /** The daemon's notice that the message wasn't delivered. */
  noticeId?: string | undefined;
}

export interface LocalSendsView {
  /** The blocks with this window's messages on their way merged in (`itemsOf`: `blockItems`). */
  merge(blocks: readonly Block[], itemsOf: (block: Block) => readonly string[]): readonly Block[];
  /** What the bubble under `itemId` has to say. */
  find(itemId: string): LocalSend;
}

let views: ReadonlyMap<string, LocalSendsView> = new Map();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => views;

export function publishLocalSends(threadId: string, view: LocalSendsView | undefined): void {
  const next = new Map(views);
  if (view) next.set(threadId, view);
  else next.delete(threadId);
  views = next;
  for (const listener of listeners) listener();
}

export function useLocalSendsView(threadId: string): LocalSendsView | undefined {
  return useSyncExternalStore(subscribe, snapshot, snapshot).get(threadId);
}
