import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { metadataDirectory, text } from "./lease-journal.ts";

/** The shared metadata directory of the repository a checkout belongs to, read without Git. */
async function commonDirectory(root: string): Promise<string | undefined> {
  try {
    const metadata = await metadataDirectory(root);
    if (!metadata) return undefined;
    const common = await text(join(metadata, "commondir"));
    return await realpath(common ? resolve(metadata, common.replace(/\n$/, "")) : metadata);
  } catch {
    return undefined;
  }
}

/**
 * Of `paths` (relative to `root`, each with its own `.git`), the ones that are linked worktrees
 * of `root`'s own repository, such as `.claude/worktrees/agent-*`. They are other checkouts of
 * this history, not nested repositories, and are never snapshotted into `root`.
 */
export async function sameRepositoryWorktrees(
  root: string,
  paths: readonly string[],
): Promise<Set<string>> {
  const linked = new Set<string>();
  if (!paths.length) return linked;
  const own = await commonDirectory(root);
  if (!own) return linked;
  for (let start = 0; start < paths.length; start += 64) {
    const batch = paths.slice(start, start + 64);
    const found = await Promise.all(
      batch.map(async (path) => {
        const checkout = join(root, path);
        try {
          // A `.git` directory is a repository of its own; only `.git` files link worktrees.
          if (!(await lstat(join(checkout, ".git"))).isFile()) return false;
        } catch {
          return false;
        }
        return (await commonDirectory(checkout)) === own;
      }),
    );
    for (const [index, path] of batch.entries()) if (found[index]) linked.add(path);
  }
  return linked;
}
