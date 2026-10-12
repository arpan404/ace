import {
  findDraft,
  putDraft,
  readJson,
  touchRecent,
  writeJson,
  type ComposerDraft,
  type DraftEntries,
  type KeyValueStorage,
} from "@ace/ui-core";
import { CatalogMention, Mention, ThreadRefContextItem } from "@ace/protocol";
import { z as classic } from "zod";
import * as z from "zod/mini";

/*
 * Unsent drafts and recently mentioned files, kept on this device. Each write reads the stored
 * list again first, so two tabs editing different threads never drop each other's drafts.
 */
const Token = classic.object({
  start: classic.number().int().nonnegative(),
  end: classic.number().int().positive(),
  label: classic.string(),
  catalog: CatalogMention.optional(),
  file: Mention.optional(),
  thread: ThreadRefContextItem.optional(),
});
export const ComposerDraftSchema = classic.object({
  tokens: classic.array(Token).optional(),
  text: classic.string(),
  mentions: classic.array(classic.string()),
  attachments: classic.array(classic.object({ sha256: classic.string(), name: classic.string() })),
});
const Entries = z.catch(z.array(z.tuple([z.string(), ComposerDraftSchema])), []);
const Recent = z.catch(z.array(z.tuple([z.string(), z.array(z.string())])), []);

export const draftsKey = "ace.composer.drafts";
const recentKey = "ace.composer.recent";
const recentPerProject = 6;
const recentProjects = 16;
const isPreparation = (id: string) => id.startsWith("new:[");

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
  return findDraft(readJson(storage, draftsKey, Entries, []), key);
}

export function writeDraft(
  storage: KeyValueStorage | undefined,
  key: string,
  draft: ComposerDraft | undefined,
): boolean {
  const entries: DraftEntries = readJson(storage, draftsKey, Entries, []);
  // Visible preparations are protected from the transient thread composer cache's eviction.
  const protectedDrafts = entries.filter(([id]) => isPreparation(id));
  const transient = entries.filter(([id]) => !isPreparation(id));
  const creating = isPreparation(key) && draft && (draft.text.trim() || draft.attachments.length);
  if (creating && protectedDrafts.length >= 50 && !protectedDrafts.some(([id]) => id === key))
    return false;
  const next = isPreparation(key)
    ? [...transient, ...putDraft(protectedDrafts, key, draft)]
    : [...putDraft(transient, key, draft), ...protectedDrafts];
  if (!storage || storage.durable === false) {
    retain(storage, key, draft);
    return false;
  }
  try {
    storage.setItem(draftsKey, JSON.stringify(next));
    recovery(storage)?.delete(key);
    return true;
  } catch {
    retain(storage, key, draft);
    return false;
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

/** `writeDraft` for a draft held as JSON (the composer serialises it to notice changes). */
export function writeDraftJson(
  storage: KeyValueStorage | undefined,
  key: string,
  json: string,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  const draft = ComposerDraftSchema.safeParse(parsed);
  return draft.success && writeDraft(storage, key, draft.data);
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
