import { readJson, type KeyValueStorage } from "@ace/ui-core";
import { useSyncExternalStore } from "react";
import * as z from "zod/mini";

/*
 * Forks opened and not yet sent, kept on this device per daemon. A fork draft is only a place to
 * come back to: nothing exists on the daemon, and no provider session is forked, until its first
 * message is sent. Its message lives in the composer drafts under the same key.
 */

const ForkDraft = z.object({
  threadId: z.string().check(z.minLength(1)),
  run: z.optional(z.string().check(z.minLength(1))),
  item: z.optional(z.string().check(z.minLength(1))),
});
export type ForkDraft = z.infer<typeof ForkDraft>;
const Drafts = z.catch(z.array(ForkDraft), []);
const storageKey = (host: string) => `ace.forkDrafts:${host}`;
/** At most this many are kept; opening another drops the oldest. */
const limit = 50;

/** One fork draft's key: the place it forks from. The composer keeps its message under it. */
export const forkDraftKey = (draft: ForkDraft) =>
  `fork:${draft.threadId}:${draft.run ?? draft.item ?? ""}`;

const listeners = new Set<() => void>();
let revision = 0;
function changed() {
  revision++;
  // A listener may unsubscribe while it runs.
  const pending = [...listeners];
  for (const listener of pending) listener();
}
function external(event: StorageEvent) {
  if (event.key === null || event.key.startsWith("ace.forkDrafts:")) changed();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) addEventListener("storage", external);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) removeEventListener("storage", external);
  };
}

/** Newest first. */
export function forkDrafts(storage: KeyValueStorage | undefined, host: string): ForkDraft[] {
  return readJson(storage, storageKey(host), Drafts, []);
}

function write(storage: KeyValueStorage | undefined, host: string, drafts: ForkDraft[]): boolean {
  if (!storage || storage.durable === false) return false;
  try {
    storage.setItem(storageKey(host), JSON.stringify(drafts));
    changed();
    return true;
  } catch {
    return false;
  }
}

/** Opening a fork keeps it as a draft; opening it again moves it to the top. */
export function saveForkDraft(
  storage: KeyValueStorage | undefined,
  host: string,
  draft: ForkDraft,
): boolean {
  const key = forkDraftKey(draft);
  const rest = forkDrafts(storage, host).filter((saved) => forkDraftKey(saved) !== key);
  return write(storage, host, [draft, ...rest].slice(0, limit));
}

/** Sending its first message, or discarding it, ends a fork draft. */
export function removeForkDraft(
  storage: KeyValueStorage | undefined,
  host: string,
  key: string,
): boolean {
  const drafts = forkDrafts(storage, host);
  const rest = drafts.filter((saved) => forkDraftKey(saved) !== key);
  return rest.length === drafts.length || write(storage, host, rest);
}

const cache = new WeakMap<KeyValueStorage, Map<string, { revision: number; rows: ForkDraft[] }>>();
const none: ForkDraft[] = [];
function rowsAt(storage: KeyValueStorage | undefined, host: string | undefined): ForkDraft[] {
  if (!storage || !host) return none;
  let hosts = cache.get(storage);
  if (!hosts) {
    hosts = new Map();
    cache.set(storage, hosts);
  }
  const cached = hosts.get(host);
  if (cached?.revision === revision) return cached.rows;
  const rows = forkDrafts(storage, host);
  hosts.set(host, { revision, rows });
  return rows;
}

/** This daemon's fork drafts as state, newest first. */
export function useForkDrafts(storage: KeyValueStorage | undefined, host: string | undefined) {
  return useSyncExternalStore(subscribe, () => rowsAt(storage, host));
}
