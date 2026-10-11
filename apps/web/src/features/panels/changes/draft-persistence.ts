import { readJson, writeJson, type KeyValueStorage, type SafeParser } from "@ace/ui-core";
import * as z from "zod/mini";
import type { LocalStore } from "../store.ts";
import type { ReviewDraft } from "./drafts.ts";

const legacyKey = "ace.review.drafts";
const prefix = "ace.review.draft:";
const deletedPrefix = "ace.review.deleted:";
const indexKey = "ace.review.draft-index";
const Index = z.array(z.string());
const Deleted = z.literal(true);
const owners = new WeakMap<KeyValueStorage, Set<() => void>>();

type Storage = KeyValueStorage & { key?(index: number): string | null; readonly length?: number };

/** Web Storage enumerates independent records. Minimal injected stores share a local index. */
function names(storage: Storage): string[] {
  if (storage.key && storage.length !== undefined) {
    const found: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) found.push(key.slice(prefix.length));
    }
    return found;
  }
  return readJson(storage, indexKey, Index, []);
}

/**
 * Each draft has its own durable record, so independent tab writes never replace an array.
 * Deletion is a separate tombstone: even a concurrent stale write cannot resurrect that id.
 * Fresh comments get a fresh key; editing an unsent comment retains its key.
 */
export function persistDrafts(
  store: LocalStore<readonly ReviewDraft[]>,
  storage: Storage,
  schema: SafeParser<ReviewDraft>,
  settle: (draft: ReviewDraft) => ReviewDraft,
  subscribe: (changed: () => void) => void,
) {
  const listeners = owners.get(storage) ?? new Set<() => void>();
  owners.set(storage, listeners);
  const pendingWrites = new Map<string, ReviewDraft>();
  const pendingDeletes = new Set<string>();
  const remove = (key: string) => {
    try {
      storage.removeItem?.(key);
    } catch {
      /* Storage may be unavailable. */
    }
  };
  const deleted = (key: string) => readJson(storage, deletedPrefix + key, Deleted, undefined);
  const write = (draft: ReviewDraft) => {
    if (deleted(draft.key)) return;
    writeJson(storage, prefix + draft.key, draft);
    const saved = readJson(storage, prefix + draft.key, schema, undefined);
    if (JSON.stringify(saved) === JSON.stringify(draft)) pendingWrites.delete(draft.key);
    else pendingWrites.set(draft.key, draft);
    if (!storage.key || storage.length === undefined) {
      const index = new Set(readJson(storage, indexKey, Index, []));
      index.add(draft.key);
      writeJson(storage, indexKey, [...index]);
    }
  };
  // Migrate once, without overwriting a newer per-record edit or tombstone from another tab.
  const Legacy = z.array(z.unknown());
  for (const entry of readJson(storage, legacyKey, Legacy, [])) {
    const draft = schema.safeParse(entry);
    if (draft.success && !readJson(storage, prefix + draft.data.key, schema, undefined))
      write(draft.data);
  }
  if (!pendingWrites.size) remove(legacyKey);
  const all = () => {
    const records = new Map<string, ReviewDraft>();
    for (const key of names(storage)) {
      if (deleted(key) || pendingDeletes.has(key)) continue;
      const draft = readJson(storage, prefix + key, schema, undefined);
      if (draft) records.set(key, draft);
    }
    // A denied storage write must not discard this page's in-memory work.
    for (const [key, draft] of pendingWrites)
      if (!deleted(key) && !pendingDeletes.has(key)) records.set(key, draft);
    return [...records.values()].toSorted((a, b) => b.createdAt - a.createdAt);
  };
  const erase = (key: string) => {
    writeJson(storage, deletedPrefix + key, true);
    if (!deleted(key)) pendingDeletes.add(key);
    pendingWrites.delete(key);
    remove(prefix + key);
  };
  const read = () => all().slice(0, 400);
  const restored = new Map<string, { raw: string; draft: ReviewDraft }>();
  let held: readonly ReviewDraft[] = read().map((draft) => {
    const settled = settle(draft);
    if (settled !== draft) restored.set(draft.key, { raw: JSON.stringify(draft), draft: settled });
    return settled;
  });
  let refreshing = false;
  store.set(() => held);
  const refresh = () => {
    const next = read().map((draft) => {
      const recovery = restored.get(draft.key);
      if (recovery?.raw === JSON.stringify(draft)) return recovery.draft;
      restored.delete(draft.key);
      return draft;
    });
    // Keep this page's active operations; restoring in-flight state is only for initial load.
    held = next;
    refreshing = true;
    store.set(() => next);
    refreshing = false;
  };
  listeners.add(refresh);
  subscribe(refresh);
  store.subscribe(() => {
    if (refreshing) return;
    const next = store.get();
    const before = new Map(held.map((draft) => [draft.key, draft]));
    const after = new Map(next.map((draft) => [draft.key, draft]));
    for (const draft of held)
      if (!after.has(draft.key)) {
        erase(draft.key);
      }
    for (const draft of next) if (before.get(draft.key) !== draft) write(draft);
    for (const evicted of all().slice(400)) {
      erase(evicted.key);
    }
    held = next;
    for (const changed of listeners) changed();
  });
}
