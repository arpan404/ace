import type { FolderEntry, FolderPage, GitStatusFile } from "@ace/protocol";
import {
  changeLetters,
  folderRows,
  fuzzyPositions,
  parentPath,
  pathParts,
  type FolderStates,
} from "@ace/ui-core";

/*
 * The Files screen's lazy tree as data: the rows the phone draws from the folders it has listed
 * (the shared `@ace/ui-core` lazy tree), each uncommitted change lettered as the web letters it,
 * and files git still reports as deleted though they are no longer on disk. Pure, so the bridge
 * tests its rows without a daemon.
 */

/** A row the phone draws. Entry rows carry the checkout path in `key` (folders end in "/"). */
export interface TreeRow {
  key: string;
  kind: "file" | "folder" | "loading" | "more" | "error";
  name: string;
  depth: number;
  expanded: boolean;
  /** Listed but excluded by the checkout's gitignore rules: shown, dimmed. */
  ignored: boolean;
  /** "M", "A", "D", "R" or "U" for an uncommitted change. */
  mark?: string;
  /** The mark's word ("Modified"), for VoiceOver. */
  markLabel?: string;
  /** The folder a loading, more or error row belongs to. */
  folder?: string;
  /** What an error row says. */
  error?: string;
}

/**
 * `page` plus the deleted files `changes` names directly in `folder`, which a listing never
 * returns because they are gone. They carry the "D" mark and stay until git stops naming them.
 */
export function withDeletedEntries(
  folder: string,
  page: FolderPage,
  changes: readonly GitStatusFile[],
): FolderPage {
  const shown = new Set(page.entries.map((entry) => entry.path));
  const missing: FolderEntry[] = [];
  for (const change of changes) {
    if (change.status !== "deleted" || shown.has(change.path)) continue;
    if (parentPath(change.path) !== folder) continue;
    missing.push({
      name: pathParts(change.path).name,
      path: change.path,
      kind: "file",
      size: 0,
      mtimeMs: 0,
      ignored: false,
    });
  }
  return missing.length ? { ...page, entries: [...page.entries, ...missing] } : page;
}

/** The tree's rows, in order, with each entry's uncommitted change letter when it has one. */
export function treeRows(
  folders: FolderStates,
  open: ReadonlySet<string>,
  changes: readonly GitStatusFile[],
): TreeRow[] {
  const status = new Map(changes.map((change) => [change.path, change]));
  return folderRows(folders, open).map((row) => {
    // Only a file's path is a git status path; a folder's key ends in "/".
    const change = row.kind === "file" ? status.get(row.key) : undefined;
    const out: TreeRow = {
      key: row.key,
      kind: row.kind,
      name: row.name,
      depth: row.depth,
      expanded: row.expanded,
      ignored: row.ignored,
    };
    if (change) {
      out.mark = changeLetters[change.status].letter;
      out.markLabel = changeLetters[change.status].label;
    }
    if (row.folder !== undefined) out.folder = row.folder;
    if (row.error !== undefined) out.error = row.error;
    return out;
  });
}

export interface SearchRow {
  path: string;
  name: string;
  /** The folder above it ("" at the top). */
  folder: string;
  isFolder: boolean;
  /** UTF-16 offsets in `path` the query's characters matched, for highlighting. */
  positions: number[];
}

/** Quick-open results as rows: the daemon's best-first paths with the matched characters. */
export function searchRows(query: string, paths: readonly string[]): SearchRow[] {
  return paths.map((path) => {
    const isFolder = path.endsWith("/");
    const bare = isFolder ? path.slice(0, -1) : path;
    const parts = pathParts(path);
    return {
      path,
      name: parts.name,
      folder: parts.folder,
      isFolder,
      positions: fuzzyPositions(query.trim(), bare) ?? [],
    };
  });
}
