import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Repository } from "./repository.ts";
import type { Worktree } from "./types.ts";

function absent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/** A path with its existing ancestors' aliases (symlinks, /tmp) resolved, even if it is gone. */
async function physical(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!absent(error)) throw error;
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(await physical(parent), basename(absolute));
  }
}

/**
 * A registered worktree whose folder was deleted by hand. Git marks it `prunable`; ace also
 * checks the folder itself, so an entry with damaged metadata but a real folder is never treated
 * as gone.
 */
export async function isMissing(tree: Worktree): Promise<boolean> {
  if (tree.prunable === null || tree.bare) return false;
  try {
    await lstat(tree.path);
    return false;
  } catch (error) {
    if (absent(error)) return true;
    throw error;
  }
}

/** The registered, missing worktree at `path`, and whether it is the main worktree. */
export async function findMissing(
  trees: readonly Worktree[],
  path: string,
): Promise<{ tree: Worktree; main: boolean } | undefined> {
  const wanted = await physical(path);
  for (const [index, tree] of trees.entries()) {
    if ((await physical(tree.path)) !== wanted) continue;
    return (await isMissing(tree)) ? { tree, main: index === 0 } : undefined;
  }
  return undefined;
}

/**
 * Drop exactly one missing worktree's registration. `git worktree remove` of a missing path
 * deletes only that entry's administrative files; it never prunes other worktrees.
 */
export async function forgetMissing(repository: Repository, root: string, tree: Worktree) {
  await repository.cli.call(
    root,
    ["-c", "core.hooksPath=/dev/null", "worktree", "remove", "--", tree.path],
    { write: true },
  );
}

/** Missing registrations that would block a new worktree at `path` or on `branch`. */
export async function missingBlockers(
  trees: readonly Worktree[],
  path: string,
  branch: string,
): Promise<Worktree[]> {
  const wanted = await physical(path);
  const blockers: Worktree[] = [];
  for (const tree of trees.slice(1)) {
    if (tree.branch !== branch && (await physical(tree.path)) !== wanted) continue;
    if (await isMissing(tree)) blockers.push(tree);
  }
  return blockers;
}
