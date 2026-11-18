/*
 * The Files explorer's lazy tree as data: one folder listed at a time, pages merged as they
 * arrive, and the rows a virtual list draws from the folders the person opened. Pure, so the web
 * client tests its rules without a daemon or a DOM.
 */

import type { FolderEntry, FolderPage } from "@ace/protocol";
import { ancestorFolders, cleanPath } from "./checkout-files.ts";

/** What the tree knows about one folder. */
export interface FolderState {
  /** The pages listed so far, in the daemon's order (folders first, then natural by name). */
  entries: readonly FolderEntry[];
  /** The next page's cursor: null on the last page, undefined before a first page arrives. */
  nextCursor: string | null | undefined;
  /** Every entry the folder holds, not only the pages listed so far. */
  total: number;
  loading: boolean;
  /** Why the last page failed, as a sentence the tree shows under the folder. */
  error: string | undefined;
}

export type FolderStates = Readonly<Record<string, FolderState>>;

export const emptyFolder: FolderState = {
  entries: [],
  nextCursor: undefined,
  total: 0,
  loading: false,
  error: undefined,
};

/** A folder key: "" for the checkout's root, otherwise ending in "/" ("src/"). */
export function folderKey(path: string): string {
  const clean = cleanPath(path);
  return clean ? `${clean}/` : "";
}

/** A folder as a listing request names it: "" for the root, otherwise no trailing slash. */
export function folderRequestPath(folder: string): string {
  return cleanPath(folder);
}

/** The most folders one `files.watch` names. */
export const watchedFolderLimit = 512;

/**
 * The folders a client watches for a tree: the root and every open folder, without trailing
 * slashes, at most 512 of them. Sorted, so an unchanged tree sends an unchanged message.
 */
export function watchedFolders(open: Iterable<string>): string[] {
  const paths = new Set<string>();
  for (const folder of open) {
    const path = folderRequestPath(folder);
    if (path) paths.add(path);
  }
  return ["", ...[...paths].toSorted()].slice(0, watchedFolderLimit);
}

/**
 * The open folders a `files.folders_changed` asks to list again: only those in the open set, or
 * every one of them when the watcher fell behind and asked for a rescan.
 */
export function foldersToRelist(
  open: Iterable<string>,
  changed: readonly string[],
  rescan: boolean,
): string[] {
  const folders = [...open];
  if (rescan) return folders;
  const named = new Set(changed.map(folderKey));
  return folders.filter((folder) => named.has(folder));
}

/**
 * The folders a tab shows open: the person's own choices, or only the current file's ancestors
 * until they open one. `current` is the file shown beside the tree, if any.
 */
export function openedFolders(
  stored: readonly string[] | undefined,
  current: string | undefined,
): ReadonlySet<string> {
  if (stored) return new Set(stored.map(folderKey));
  return new Set(current ? ancestorFolders(current) : []);
}

/** The current file's ancestors the open set is missing, to reveal it in the tree. */
export function revealingFolders(open: ReadonlySet<string>, current: string | undefined): string[] {
  if (!current) return [];
  return ancestorFolders(current).filter((folder) => !open.has(folder));
}

/** `open` with `folder` opened or folded; the person's choice is the tab's to keep. */
export function toggledFolders(
  open: ReadonlySet<string>,
  folder: string,
  expand: boolean,
): ReadonlySet<string> {
  const next = new Set(open);
  if (expand) next.add(folder);
  else next.delete(folder);
  return next;
}

/**
 * The open folders that are actually on screen: a folder shows only while every folder above
 * it is open too. Root is always visible; a folder whose parent was folded is neither listed
 * nor watched until its parent opens again, though what it loaded is kept.
 */
export function visibleFolders(open: Iterable<string>): ReadonlySet<string> {
  const all = new Set([""]);
  for (const folder of open) if (folder) all.add(folderKey(folder));
  const visible = new Set([""]);
  for (const folder of all)
    if (folder && ancestorFolders(folder).every((parent) => all.has(parent))) visible.add(folder);
  return visible;
}

/** Start listing `folder`: a first page forgets the old cursor, a later page keeps it. */
export function startingFolderPage(
  folders: FolderStates,
  folder: string,
  first: boolean,
): FolderStates {
  const state = folders[folder] ?? emptyFolder;
  return {
    ...folders,
    [folder]: {
      ...state,
      loading: true,
      error: undefined,
      ...(first ? { nextCursor: undefined } : {}),
    },
  };
}

function mergedPages(current: readonly FolderEntry[], page: readonly FolderEntry[]): FolderEntry[] {
  const seen = new Set(current.map((entry) => entry.path));
  const entries = [...current];
  for (const entry of page) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    entries.push(entry);
  }
  return entries;
}

/**
 * A folder's page arrived: a first page replaces what was listed, a later one appends what it
 * hasn't shown, so the pages join without gaps or duplicates. A page for a cursor the folder
 * moved past (a page that would leave a gap) is ignored.
 */
export function folderPageArrived(
  folders: FolderStates,
  folder: string,
  page: FolderPage,
  cursor: string | undefined,
): FolderStates {
  const state = folders[folder] ?? emptyFolder;
  if (cursor !== undefined && state.nextCursor !== cursor) return folders;
  return {
    ...folders,
    [folder]: {
      entries: mergedPages(cursor === undefined ? [] : state.entries, page.entries),
      nextCursor: page.nextCursor,
      total: page.total,
      loading: false,
      error: undefined,
    },
  };
}

/**
 * A folder's page failed. `INVALID_CURSOR` means the folder changed while it was read: forget
 * the pages listed so far and start it again. Any other failure keeps what was listed and says
 * why the next page didn't arrive.
 */
export function folderPageFailed(
  folders: FolderStates,
  folder: string,
  failure: { code: string; message: string },
): FolderStates {
  const state = folders[folder] ?? emptyFolder;
  if (failure.code === "INVALID_CURSOR") {
    return { ...folders, [folder]: { ...emptyFolder, loading: true } };
  }
  return { ...folders, [folder]: { ...state, loading: false, error: failure.message } };
}

/**
 * The request for `folder` was stopped (it was folded, the tree paused or the connection went
 * away): nothing is on its way any more, so it is no longer loading.
 */
export function folderStopped(folders: FolderStates, folder: string): FolderStates {
  const state = folders[folder];
  if (!state?.loading) return folders;
  return { ...folders, [folder]: { ...state, loading: false } };
}

/**
 * What Try again asks for after a failure: the page that failed. A failed next page keeps its
 * cursor, so it asks for that page; a failed first page (or a folder with no error) starts over.
 */
export function folderRetry(
  state: FolderState | undefined,
): { mode: "first" } | { mode: "more"; cursor: string } {
  if (state?.error && typeof state.nextCursor === "string")
    return { mode: "more", cursor: state.nextCursor };
  return { mode: "first" };
}

/** A row of the tree the virtual list draws. Entry rows carry a checkout path. */
export interface FolderRow {
  /** The row's path for an entry; a synthetic key for a loading, more or error row. */
  key: string;
  kind: "file" | "folder" | "loading" | "more" | "error";
  name: string;
  depth: number;
  /** A folder's row only: whether its children show. */
  expanded: boolean;
  /** A folder's row only: whether its children are on their way. */
  busy: boolean;
  /** Listed but excluded by the checkout's gitignore rules: shown, dimmed. */
  ignored: boolean;
  /** The folder a loading, more or error row belongs to. */
  folder?: string;
  /** What an error row says. */
  error?: string;
}

const row = (
  entry: FolderEntry,
  depth: number,
  expanded: boolean,
  folders: FolderStates,
): FolderRow => {
  const opens = entryOpens(entry);
  const state = folders[folderKey(entry.path)];
  return {
    key: opens ? folderKey(entry.path) : entry.path,
    kind: opens ? "folder" : "file",
    name: entry.name,
    depth,
    expanded,
    busy: opens && expanded && (state === undefined || state.loading),
    ignored: entry.ignored,
  };
};

/** Whether an entry opens into a folder: a folder, or a link to one. */
export function entryOpens(entry: FolderEntry): boolean {
  return entry.kind === "directory" || (entry.kind === "symlink" && entry.target === "directory");
}

function statusRow(
  kind: "loading" | "more" | "error",
  folder: string,
  depth: number,
  name: string,
  error?: string,
): FolderRow {
  return {
    key: `${kind}:${folder}`,
    kind,
    name,
    depth,
    expanded: false,
    busy: false,
    ignored: false,
    folder,
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * The rows the tree shows: the root's entries, then every open folder's entries under their
 * folder. A folder with nothing listed yet shows one Loading… row; a folder with entries that
 * is still loading keeps them. A folder with another page shows Show more, which asks for it.
 * Folders that aren't open list nothing.
 */
export function folderRows(folders: FolderStates, expanded: ReadonlySet<string>): FolderRow[] {
  const rows: FolderRow[] = [];
  const walk = (folder: string, depth: number) => {
    const state = folders[folder];
    if (!state) {
      rows.push(statusRow("loading", folder, depth + 1, "Loading…"));
      return;
    }
    for (const entry of state.entries) {
      const open = entryOpens(entry) && expanded.has(folderKey(entry.path));
      rows.push(row(entry, depth, open, folders));
      if (open) walk(folderKey(entry.path), depth + 1);
    }
    if (state.loading && state.entries.length === 0)
      rows.push(statusRow("loading", folder, depth + 1, "Loading…"));
    if (state.error) rows.push(statusRow("error", folder, depth + 1, state.error, state.error));
    if (!state.loading && !state.error && state.nextCursor)
      rows.push(statusRow("more", folder, depth + 1, "Show more"));
  };
  walk("", 0);
  return rows;
}
