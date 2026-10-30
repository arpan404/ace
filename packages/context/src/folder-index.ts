import { GitIgnore, SafeRoot, walkWorkspace } from "@ace/workspace";
import { PathIndex } from "./path-index.ts";
import { containedPath } from "./workspace-path.ts";
import { ContextError, requireContext } from "./errors.ts";

/** Ordinary folders use the shared bounded walker, without following links. */
export async function folderIndex(root: string, cap: number, dir = ""): Promise<PathIndex> {
  const safe = await SafeRoot.create(root);
  const ignore = await GitIgnore.create(safe);
  const index = new PathIndex(cap);
  const pending = [dir];
  let visited = 0;
  while (pending.length) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for await (const entry of walkWorkspace(safe, ignore, {
      dir: directory,
      depth: 1,
      includeIgnored: false,
      entryLimit: cap,
    })) {
      requireContext(++visited <= cap, "quota", "Workspace traversal exceeds entry budget");
      try {
        const { info } = await containedPath(root, entry.path);
        if (info.isDirectory()) pending.push(entry.path);
        else if (info.isFile()) index.update(entry.path, true);
      } catch (error) {
        if (
          !(error instanceof ContextError) ||
          !["not_found", "outside_workspace"].includes(error.code)
        )
          throw error;
      }
    }
  }
  return index;
}

export async function updateFolderIndex(
  root: string,
  index: PathIndex,
  cap: number,
  paths: readonly string[],
): Promise<void> {
  for (const path of new Set(paths)) {
    try {
      const { info, local } = await containedPath(root, path);
      if (local.split(/[\\/]/).includes(".git")) continue;
      if (info.isDirectory()) index.replaceSubtree(path, await folderIndex(root, cap, path));
      else index.update(path, info.isFile());
    } catch (error) {
      if (
        !(error instanceof ContextError) ||
        !["not_found", "outside_workspace"].includes(error.code)
      )
        throw error;
      index.update(path, false);
      for (const child of index.under(path)) index.update(child, false);
    }
  }
}
