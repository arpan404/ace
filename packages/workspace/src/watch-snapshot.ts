import type { GitIgnore } from "./ignore.ts";
import { type SafeRoot, internal } from "./safety.ts";
import { tree } from "./tree.ts";
import { aborted, TREE_CAP, WorkspaceError, type Entry } from "./types.ts";
import type { VisibleTree } from "./visible-tree.ts";

export async function fullSnapshot(
  safe: SafeRoot,
  ignore: GitIgnore,
  signal: AbortSignal,
): Promise<Map<string, Entry>> {
  const entries = new Map<string, Entry>();
  for await (const entry of tree(safe, ignore, {
    dir: "",
    depth: TREE_CAP,
    includeIgnored: false,
    signal,
  })) {
    entries.set(entry.path, entry);
  }
  return entries;
}
export async function changedSnapshot(
  safe: SafeRoot,
  ignore: GitIgnore,
  previous: VisibleTree,
  dirty: Set<string>,
  signal: AbortSignal,
): Promise<{ updates: Map<string, Entry>; removed: Set<string> }> {
  // A directory notification already covers all its descendant notifications.
  const roots: string[] = [];
  const covered = new Set<string>();
  for (const path of [...dirty].toSorted()) {
    safe.path(path);
    if (internal(path)) continue;
    let ancestor = path;
    let skip = false;
    let slash: number;
    while ((slash = ancestor.lastIndexOf("/")) >= 0) {
      ancestor = ancestor.slice(0, slash);
      if (covered.has(ancestor) || previous.get(ancestor)?.type === "symlink") {
        skip = true;
        break;
      }
    }
    if (!skip) {
      roots.push(path);
      covered.add(path);
    }
  }
  const updates = new Map<string, Entry>();
  const removed = new Set<string>();
  const metadata = new Map<string, Entry>();
  for (const path of roots) {
    aborted(signal);
    try {
      const { info, type } = await safe.metadata(path);
      metadata.set(path, { path, size: info.size, mtime: info.mtimeMs, type, ignored: false });
    } catch (error) {
      if (
        !(error instanceof WorkspaceError) ||
        !["NOT_FOUND", "PATH_ESCAPE", "NOT_DIRECTORY"].includes(error.code)
      )
        throw error;
    }
  }
  const ignored = await ignore.ignored([...metadata.keys()], signal);
  for (const path of roots) {
    aborted(signal);
    const entry = metadata.get(path);
    if (entry && !ignored.has(path)) {
      updates.set(path, entry);
      if (entry.type === "directory") {
        for await (const child of tree(safe, ignore, {
          dir: path,
          depth: TREE_CAP,
          includeIgnored: false,
          signal,
        })) {
          updates.set(child.path, child);
          if (updates.size > TREE_CAP)
            throw new WorkspaceError(
              "LIMIT_EXCEEDED",
              "Workspace watch update exceeds 100,000 entries",
            );
        }
      }
    }
    for (const before of previous.under(path))
      if (!updates.has(before.path)) removed.add(before.path);
  }
  await safe.resolve("");
  aborted(signal);
  return { updates, removed };
}
