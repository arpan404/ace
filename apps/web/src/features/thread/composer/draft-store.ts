import {
  draftLimits,
  findDraft,
  putDraft,
  readJson,
  touchRecent,
  writeJson,
  type ComposerDraft,
  type DraftEntries,
  type KeyValueStorage,
} from "@ace/ui-core";
import {
  BrowserAnnotation,
  BrowserTabContextItem,
  CatalogMention,
  Mention,
  ThreadRefContextItem,
} from "@ace/protocol";
import { z as classic } from "zod";
import { stillLimit } from "@/components/image-still.ts";
import * as z from "zod/mini";

/*
 * Unsent drafts and recently mentioned files, kept on this device. Each draft is its own storage
 * key beside a small index of keys in recency order, so saving one draft never reads, parses or
 * rewrites another, and another window hears only about the draft that changed. Each write reads
 * the index again first, so two tabs editing different threads never drop each other's drafts.
 */
const Token = classic.object({
  start: classic.number().int().nonnegative(),
  end: classic.number().int().positive(),
  label: classic.string(),
  catalog: CatalogMention.optional(),
  file: Mention.optional(),
  thread: ThreadRefContextItem.optional(),
  browserTab: BrowserTabContextItem.optional(),
  /** Where a file was added: its marker, tied to the file again by hash on restore. */
  attachment: classic
    .object({ key: classic.number().int().optional(), sha256: classic.string().optional() })
    .optional()
    .catch(undefined),
});
const Held = classic.object({ sha256: classic.string(), name: classic.string() });
const Annotated = classic.object({ annotation: BrowserAnnotation, crop: Held.optional() });
/** Annotations decode one by one: an unreadable record is dropped, never the draft. */
const DraftAnnotationsSchema = classic.object({
  items: classic.array(classic.unknown()).transform((items) =>
    items.flatMap((value) => {
      const item = Annotated.safeParse(value);
      return item.success ? [item.data] : [];
    }),
  ),
  pages: classic.array(Held.extend({ url: classic.string() })).catch([]),
});
/** A passage of an agent message being replied to; an unreadable one is dropped, never the draft. */
const Quote = classic.object({
  id: classic.string(),
  text: classic.string(),
  before: classic.string(),
  after: classic.string(),
});
const Quotes = classic.array(classic.unknown()).transform((items) =>
  items.flatMap((value) => {
    const quote = Quote.safeParse(value);
    return quote.success ? [quote.data] : [];
  }),
);
/** A kept still is a small inline image, never a link; anything else is dropped, not the file. */
const DraftFile = Held.extend({
  mimeType: classic.string().max(128).optional().catch(undefined),
  bytes: classic.number().int().nonnegative().optional().catch(undefined),
  still: classic
    .string()
    .max(stillLimit)
    .regex(/^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/]+=*$/)
    .optional()
    .catch(undefined),
});
export const ComposerDraftSchema = classic.object({
  tokens: classic.array(Token).optional(),
  text: classic.string(),
  mentions: classic.array(classic.string()),
  attachments: classic.array(DraftFile),
  annotations: DraftAnnotationsSchema.optional().catch(undefined),
  quotes: Quotes.optional().catch(undefined),
});
const Entries = z.catch(z.array(z.tuple([z.string(), ComposerDraftSchema])), []);
const Index = z.catch(z.array(z.string()), []);
const Recent = z.catch(z.array(z.tuple([z.string(), z.array(z.string())])), []);

/** Where every draft lived before each had its own key; split once, then removed. */
const legacyKey = "ace.composer.drafts";
const indexKey = "ace.composer.drafts.index";
const draftPrefix = "ace.composer.drafts:";
/** The storage key holding the draft for composer `key`. */
export const draftStorageKey = (key: string) => draftPrefix + key;
/** Whether a storage key belongs to the draft store (a draft, the index or the old list). */
export const isDraftStorageKey = (storageKey: string) => storageKey.startsWith(legacyKey);
const recentKey = "ace.composer.recent";
const recentPerProject = 6;
const recentProjects = 16;
/** New thread's preparations and unsent forks are listed as drafts, so they are never evicted. */
const isPreparation = (id: string) => id.startsWith("new:[") || id.startsWith("fork:");

// Quota refusals keep the latest copy for this page, including across composer unmounts.
// Keys stay isolated by storage boundary so one host or test cannot recover another's draft.
const retained = new WeakMap<KeyValueStorage, Map<string, ComposerDraft | undefined>>();
const withoutStorage = new Map<string, ComposerDraft | undefined>();
function recovery(storage: KeyValueStorage | undefined) {
  return storage ? retained.get(storage) : withoutStorage;
}
function retain(
  storage: KeyValueStorage | undefined,
  key: string,
  draft: ComposerDraft | undefined,
) {
  let drafts = recovery(storage);
  if (!drafts) {
    drafts = new Map();
    if (storage) retained.set(storage, drafts);
  }
  drafts.set(key, findDraft(putDraft([], key, draft), key));
}
export function draftSaveFailed(storage: KeyValueStorage | undefined, key: string): boolean {
  return recovery(storage)?.has(key) ?? false;
}

export function readDraft(
  storage: KeyValueStorage | undefined,
  key: string,
): ComposerDraft | undefined {
  const held = recovery(storage);
  if (held?.has(key)) return held.get(key);
  return readDurableDraft(storage, key);
}

/** External change detection must see the other tab's saved version, not this page's recovery. */
export function readDurableDraft(
  storage: KeyValueStorage | undefined,
  key: string,
): ComposerDraft | undefined {
  const unsplit = migrate(storage);
  const own = readJson(storage, draftStorageKey(key), ComposerDraftSchema.optional(), undefined);
  return own ?? (unsplit ? findDraft(unsplit, key) : undefined);
}

export function writeDraft(
  storage: KeyValueStorage | undefined,
  key: string,
  draft: ComposerDraft | undefined,
): boolean {
  const unsplit = migrate(storage);
  const ids = readJson(storage, indexKey, Index, []);
  // Visible preparations are protected from the transient thread composer cache's eviction.
  const protectedIds = ids.filter(isPreparation);
  const transient = ids.filter((id) => !isPreparation(id));
  const kept = findDraft(putDraft([], key, draft), key);
  const creating = isPreparation(key) && kept !== undefined;
  if (creating && protectedIds.length >= draftLimits.drafts && !protectedIds.includes(key))
    return false;
  const next = isPreparation(key)
    ? [...transient, ...putId(protectedIds, key, kept)]
    : [...putId(transient, key, kept), ...protectedIds];
  if (!storage || storage.durable === false) {
    retain(storage, key, draft);
    return false;
  }
  try {
    // The index first: a draft written without it could never be evicted.
    storage.setItem(indexKey, JSON.stringify(next));
    if (kept) storage.setItem(draftStorageKey(key), JSON.stringify(kept));
    else remove(storage, draftStorageKey(key));
    for (const id of ids)
      if (id !== key && !next.includes(id)) remove(storage, draftStorageKey(id));
    // An unsplit old list must not bring a discarded draft back.
    if (!kept && unsplit && findDraft(unsplit, key)) {
      const rest = putDraft(unsplit, key, undefined);
      storage.setItem(legacyKey, JSON.stringify(rest));
      unsplitLists.set(storage, rest);
    }
    recovery(storage)?.delete(key);
    return true;
  } catch {
    retain(storage, key, draft);
    return false;
  }
}

/** `ids` with `key` as the most recent (or without it, for an empty draft), oldest past the limit off. */
function putId(ids: readonly string[], key: string, kept: ComposerDraft | undefined) {
  const rest = ids.filter((id) => id !== key);
  return kept ? [...rest, key].slice(-draftLimits.drafts) : rest;
}

function remove(storage: KeyValueStorage, storageKey: string) {
  if (storage.removeItem) storage.removeItem(storageKey);
  else storage.setItem(storageKey, "");
}

/*
 * Drafts saved before each had its own key sit in one list. The first read or write on a page
 * splits it into per-draft keys and removes it; a draft already under its own key is newer and
 * kept. If the split is refused (storage full), the list stays and is returned, so its drafts
 * are still read from it; the split is tried again on the next page.
 */
const split = new WeakSet<KeyValueStorage>();
const unsplitLists = new WeakMap<KeyValueStorage, DraftEntries>();
function migrate(storage: KeyValueStorage | undefined): DraftEntries | undefined {
  if (!storage || storage.durable === false) return undefined;
  if (split.has(storage)) return unsplitLists.get(storage);
  split.add(storage);
  let raw: string | null;
  try {
    raw = storage.getItem(legacyKey);
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  const entries = readJson(storage, legacyKey, Entries, []);
  try {
    const ids = readJson(storage, indexKey, Index, []);
    const moved = entries.map(([id]) => id).filter((id) => !ids.includes(id));
    for (const [id, draft] of entries)
      if (storage.getItem(draftStorageKey(id)) === null)
        storage.setItem(draftStorageKey(id), JSON.stringify(draft));
    storage.setItem(indexKey, JSON.stringify([...moved, ...ids]));
    remove(storage, legacyKey);
    return undefined;
  } catch {
    unsplitLists.set(storage, entries);
    return entries;
  }
}

// Explicit discard cancels an open editor's pending write before it unmounts.
const discards = new Set<(storage: KeyValueStorage | undefined, key: string) => void>();
export function onDraftDiscard(
  listener: (storage: KeyValueStorage | undefined, key: string) => void,
) {
  discards.add(listener);
  return () => {
    discards.delete(listener);
  };
}
export function discardDraft(storage: KeyValueStorage | undefined, key: string): boolean {
  if (!writeDraft(storage, key, undefined)) return false;
  const pending = [...discards];
  for (const listener of pending) listener(storage, key);
  return true;
}

/** Files mentioned lately in a project, most recent first. */
export function recentFiles(
  storage: KeyValueStorage | undefined,
  workspaceId: string,
): readonly string[] {
  const entries = readJson(storage, recentKey, Recent, []);
  return entries.find(([id]) => id === workspaceId)?.[1] ?? [];
}

export function rememberFile(
  storage: KeyValueStorage | undefined,
  workspaceId: string,
  path: string,
): void {
  const entries = readJson(storage, recentKey, Recent, []);
  const files = touchRecent(
    entries.find(([id]) => id === workspaceId)?.[1] ?? [],
    path,
    recentPerProject,
  );
  const rest = entries.filter(([id]) => id !== workspaceId);
  writeJson(storage, recentKey, [...rest, [workspaceId, files]].slice(-recentProjects));
}
