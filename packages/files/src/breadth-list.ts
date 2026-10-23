import { listWorkspace, type GitIgnore, type SafeRoot } from "@ace/workspace";

/** The most entries one folder's listing returns; a folder with more is cut there. */
const folderLimit = 1000;

/**
 * A folder's paths level by level, at most `limit`, folders ending in `/`: every entry of the
 * folder before anything inside its subfolders, then the next level down. A listing that hits
 * the limit drops the deepest paths. A depth-first walk spent the whole limit inside the first
 * large folder of a big checkout, so the folders after it at the top never showed.
 */
export async function breadthFirstPaths(
  safe: SafeRoot,
  ignore: GitIgnore,
  root: string,
  limit: number,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ paths: string[]; truncated: boolean }> {
  // One git ignore stream for every folder of the walk, not one process per folder.
  return ignore.scan(signal, (scoped) => walk(safe, scoped, root, limit));
}

async function walk(
  safe: SafeRoot,
  ignore: GitIgnore,
  root: string,
  limit: number,
): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = [];
  let truncated = false;
  let level = [root];
  while (level.length > 0) {
    const next: string[] = [];
    for (const dir of level) {
      const page = await listWorkspace(safe, ignore, { dir, depth: 1, limit: folderLimit });
      if (page.truncated) truncated = true;
      for (const entry of page.entries) {
        if (entry.type !== "file" && entry.type !== "directory") continue;
        if (paths.length >= limit) return { paths, truncated: true };
        paths.push(entry.type === "directory" ? `${entry.path}/` : entry.path);
        if (entry.type === "directory") next.push(entry.path);
      }
    }
    level = next;
  }
  return { paths, truncated };
}
