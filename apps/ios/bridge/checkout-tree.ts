import type { GitStatusFile } from "@ace/protocol";
import {
  ancestorFolders,
  buildFileTree,
  changeLetters,
  checkoutTreeRows,
  fuzzyPositions,
  pathParts,
} from "@ace/ui-core";

/*
 * The Files screen's tree and quick-open rows, pure: the checkout's listed paths as a tree in
 * the web's order (folders first, by name), each row with its depth and the git status letter
 * the web shows for an uncommitted change. Files deleted since the last commit aren't on disk,
 * so git's list adds them. Folders holding a change start open.
 */

export interface TreeRow {
  /** Folders end in "/". */
  path: string;
  name: string;
  depth: number;
  folder: boolean;
  /** "M", "A", "D", "R" or "U" for an uncommitted change. */
  mark?: string;
  /** The mark's word ("Modified"), for VoiceOver. */
  markLabel?: string;
}

export function checkoutTree(
  paths: readonly string[],
  changes: readonly GitStatusFile[],
): { rows: TreeRow[]; open: string[] } {
  const status = new Map(changes.map((change) => [change.path, change.status]));
  const deleted = changes.filter((change) => change.status === "deleted").map((each) => each.path);
  const tree = buildFileTree([...paths, ...deleted]);
  const rows = checkoutTreeRows(tree, () => true).map(({ node, depth }): TreeRow => {
    const change = status.get(node.path);
    const mark = change ? changeLetters[change] : undefined;
    return {
      path: node.path,
      name: node.name,
      depth,
      folder: node.kind === "folder",
      ...(mark ? { mark: mark.letter, markLabel: mark.label } : {}),
    };
  });
  const open = new Set<string>();
  for (const change of changes) for (const folder of ancestorFolders(change.path)) open.add(folder);
  return { rows, open: [...open] };
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
