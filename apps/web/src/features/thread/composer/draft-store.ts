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
const Draft = z.object({
  tokens: z.optional(z.array(Token)),
  text: z.string(),
  mentions: z.array(z.string()),
  attachments: z.array(z.object({ sha256: z.string(), name: z.string() })),
});
const Entries = z.catch(z.array(z.tuple([z.string(), Draft])), []);
const Recent = z.catch(z.array(z.tuple([z.string(), z.array(z.string())])), []);

export const draftsKey = "ace.composer.drafts";
const recentKey = "ace.composer.recent";
const recentPerProject = 6;
const recentProjects = 16;

export function readDraft(
  storage: KeyValueStorage | undefined,
  key: string,
): ComposerDraft | undefined {
  return findDraft(readJson(storage, draftsKey, Entries, []), key);
}

export function writeDraft(
  storage: KeyValueStorage | undefined,
  key: string,
  draft: ComposerDraft | undefined,
): void {
  const entries: DraftEntries = readJson(storage, draftsKey, Entries, []);
  writeJson(storage, draftsKey, putDraft(entries, key, draft));
}

/** `writeDraft` for a draft held as JSON (the composer serialises it to notice changes). */
export function writeDraftJson(
  storage: KeyValueStorage | undefined,
  key: string,
  json: string,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return;
  }
  const draft = Draft.safeParse(parsed);
  if (draft.success) writeDraft(storage, key, draft.data);
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
