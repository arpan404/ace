/*
 * Single-chain folders compacted into one row ("apps/web/src"), as the explorer shows them: a
 * folder whose whole listing is one folder joins that folder's row. The tree is lazy, so a chain
 * is only as long as what has been listed; opening its first folder opens the rest of it, so
 * each is listed (and watched) in turn and the row grows as their pages arrive.
 */

import type { FolderEntry } from "@ace/protocol";
import {
  entryOpens,
  folderKey,
  listedRows,
  type FolderRow,
  type FolderStates,
} from "./folder-tree.ts";

/** The one folder `folder` holds, when it is fully listed and holds nothing else. */
function onlyFolderIn(folders: FolderStates, folder: string): FolderEntry | undefined {
  const state = folders[folder];
  if (!state || state.loading || state.error || state.nextCursor !== null) return undefined;
  const [only, ...rest] = state.entries;
  return only && !rest.length && entryOpens(only) ? only : undefined;
}

/**
 * `open` with the rest of each open folder's chain: a folder that is the only entry of an open
 * folder (not the root, which has no row of its own) counts as open too.
 */
export function chainedOpenFolders(
  folders: FolderStates,
  open: ReadonlySet<string>,
): ReadonlySet<string> {
  const all = new Set(open);
  for (const start of open) {
    let folder = folderKey(start);
    const seen = new Set<string>();
    while (folder && !seen.has(folder)) {
      seen.add(folder);
      const only = onlyFolderIn(folders, folder);
      if (!only) break;
      folder = folderKey(only.path);
      all.add(folder);
    }
  }
  return all;
}

/**
 * The tree's rows with single-chain folders as one row: its name the chain's names joined by
 * "/", its key the last folder (what its menu, drops and new entries act on), `chain` every
 * folder in it, folded as its first one is. `expanded` is the open set from `chainedOpenFolders`.
 */
export function compactFolderRows(
  folders: FolderStates,
  expanded: ReadonlySet<string>,
): FolderRow[] {
  return listedRows(folders, expanded, (entry) => {
    const chain = [entry];
    const seen = new Set<string>();
    let folder = folderKey(entry.path);
    while (!seen.has(folder)) {
      seen.add(folder);
      const only = onlyFolderIn(folders, folder);
      if (!only) break;
      chain.push(only);
      folder = folderKey(only.path);
    }
    return chain;
  });
}
