import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import * as z from "zod/mini";

/*
 * What this window knows about messages on their way that the client's outbox doesn't (UX audit
 * SY-2, SY-3): a message still waiting for its files to upload before it can be enqueued, the
 * local previews of the images it carries, failed sends the person dismissed (Retry or Edit
 * replaced them), and which composer takes a failed message back for editing. The outbox itself
 * (`usePendingSends`) owns everything that was enqueued.
 */

/** An attachment as this window saw it before the daemon had the message. */
export interface LocalAttachment {
  sha256: string | undefined;
  name: string;
  mimeType: string;
  bytes: number;
  /** A `blob:` URL for an image, owned by this store once the message is sent. */
  previewUrl: string | undefined;
}

/** A message held back until its uploads finish; it has its command id already. */
export interface StagedSend {
  commandId: string;
  threadId: string;
  text: string;
  attachments: readonly LocalAttachment[];
  /** How many of its files are still uploading. */
  uploading: number;
}

type Listener = () => void;

/** A tiny observable map, read through `useSyncExternalStore`. */
class Observable<T> {
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

const noStaged: readonly StagedSend[] = [];

/** Messages waiting for their uploads, by thread, oldest first. */
export const stagedSends = new Observable<ReadonlyMap<string, readonly StagedSend[]>>(new Map());

export function stagedFor(threadId: string): readonly StagedSend[] {
  return stagedSends.get().get(threadId) ?? noStaged;
}

export function stage(send: StagedSend): void {
  const all = new Map(stagedSends.get());
  const list = (all.get(send.threadId) ?? noStaged).filter((s) => s.commandId !== send.commandId);
  all.set(send.threadId, [...list, send]);
  stagedSends.set(all);
}

export function unstage(threadId: string, commandId: string): void {
  const list = stagedSends.get().get(threadId);
  if (!list?.some((send) => send.commandId === commandId)) return;
  const all = new Map(stagedSends.get());
  const rest = list.filter((send) => send.commandId !== commandId);
  if (rest.length) all.set(threadId, rest);
  else all.delete(threadId);
  stagedSends.set(all);
}

/*
 * Local attachment details by content hash: names and previews for a message the daemon hasn't
 * echoed yet. Bounded; the oldest previews are released first.
 */
const localLimit = 64;
const locals = new Map<string, LocalAttachment>();

export function rememberAttachments(attachments: readonly LocalAttachment[]): void {
  for (const attachment of attachments) {
    if (!attachment.sha256) continue;
    const old = locals.get(attachment.sha256);
    if (old?.previewUrl && old.previewUrl !== attachment.previewUrl)
      URL.revokeObjectURL(old.previewUrl);
    locals.delete(attachment.sha256);
    locals.set(attachment.sha256, attachment);
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

/*
 * Failed sends the person has acted on (Retry sent a new one, Edit took it back). The outbox
 * keeps failed intents for a while, also across reloads, so the choice is kept on this device.
 */
const dismissedKey = "ace.sends.dismissed";
const dismissedLimit = 200;
const Dismissed = z.array(z.string());
let dismissedLoaded: ReadonlySet<string> | undefined;
export const dismissedSends = new Observable<ReadonlySet<string>>(new Set());

export function loadDismissed(storage: KeyValueStorage | undefined): ReadonlySet<string> {
  if (!dismissedLoaded) {
    dismissedLoaded = new Set(readJson(storage, dismissedKey, Dismissed, []));
    dismissedSends.seed(dismissedLoaded);
  }
  return dismissedSends.get();
}

export function dismissSend(storage: KeyValueStorage | undefined, commandId: string): void {
  const next = new Set(loadDismissed(storage));
  next.add(commandId);
  const kept = [...next].slice(-dismissedLimit);
  dismissedLoaded = new Set(kept);
  dismissedSends.set(dismissedLoaded);
  writeJson(storage, dismissedKey, kept);
}

/** A message given back to the composer: what Edit restores. */
export interface ReturnedDraft {
  text: string;
  mentions: readonly string[];
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

/** Test seam: forget everything this window held. */
export function resetSendStore(): void {
  stagedSends.set(new Map());
  for (const attachment of locals.values())
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  locals.clear();
  dismissedLoaded = undefined;
  dismissedSends.set(new Set());
  takers.clear();
}
