import { deleteUnchangedBranch } from "./branch-cleanup.ts";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Repository } from "./repository.ts";
import { serial } from "./lock.ts";
import { statusWithoutHidingFlags } from "./temporary-index.ts";
import { GitError, type Worktree } from "./types.ts";

export interface CreateWorktreeOptions {
  repo: string;
  path: string;
  baseRef: string;
  branch: string;
  reuseBranch?: boolean;
}

export async function createWorktree(
  repository: Repository,
  options: CreateWorktreeOptions,
): Promise<Worktree> {
  const root = await repository.root(options.repo);
  return serial(root, async () => {
    const { cli } = repository;
    const valid = await cli.call(root, ["check-ref-format", `refs/heads/${options.branch}`], {
      allowFailure: true,
    });
    if (!options.branch || options.branch.startsWith("-") || valid.exitCode !== 0) {
      throw new GitError("invalid_ref", `Invalid branch name: ${options.branch}`);
    }
    const sha = await repository.commit(root, options.baseRef);
    const exists = await cli.call(
      root,
      ["show-ref", "--verify", "--quiet", `refs/heads/${options.branch}`],
      { allowFailure: true },
    );
    if (exists.exitCode === 0 && !options.reuseBranch) {
      throw new GitError("branch_exists", `Branch already exists: ${options.branch}`);
    }
    const path = resolve(options.path);
    const branchArgs = exists.exitCode === 0 ? [] : ["-b", options.branch];
    try {
      await cli.call(
        root,
        [
          "worktree",
          "add",
          ...branchArgs,
          "--",
          path,
          exists.exitCode === 0 ? options.branch : sha,
        ],
        { write: true },
      );
      const canonical = await realpath(path);
      const trees = await repository.worktrees(root);
      const tree = trees.find(
        (entry) => resolve(entry.path) === canonical || resolve(entry.path) === path,
      );
      if (!tree) throw new GitError("git_failed", "Created worktree was not registered");
      return tree;
    } catch (error) {
      // The branch and checkout are one operation. Roll back only the exact resources
      // created here, preserving external edits or ref changes with compare-and-delete.
      if (exists.exitCode !== 0) {
        const trees = await repository.worktrees(root);
        const owned = trees.find(
          (tree) =>
            resolve(tree.path) === path && tree.branch === options.branch && tree.head === sha,
        );
        if (owned)
          await cli.call(root, ["worktree", "remove", "--", path], {
            write: true,
            allowFailure: true,
          });
        if (!(await repository.worktrees(root)).some((tree) => tree.branch === options.branch))
          await deleteUnchangedBranch(repository, root, {
            repo: root,
            branch: options.branch,
            expectedHead: sha,
          });
      }
      throw error;
    }
  });
}

export async function removeWorktree(
  repository: Repository,
  options: { repo: string; path: string; force?: boolean },
): Promise<void> {
  const root = await repository.root(options.repo);
  // Resolve aliases before locking and before passing a deletion target to Git.
  let target: string;
  try {
    target = await realpath(options.path);
  } catch {
    throw new GitError("worktree_not_found", `Worktree path does not exist: ${options.path}`);
  }
  await serial(target, async () => {
    const trees = await repository.worktrees(root);
    let found: Worktree | undefined;
    let main = false;
    for (const [index, tree] of trees.entries()) {
      let canonical: string;
      try {
        canonical = await realpath(tree.path);
      } catch {
        continue;
      }
      if (canonical === target) {
        found = tree;
        main = index === 0;
        break;
      }
    }
    if (!found)
      throw new GitError("worktree_not_found", "Removal target is not a registered worktree");
    if (main) throw new GitError("main_worktree", "The main worktree cannot be removed");
    if (!options.force) {
      const status = await statusWithoutHidingFlags(repository, target);
      if (
        status.staged.length ||
        status.unstaged.length ||
        status.untracked.length ||
        status.conflicted.length
      ) {
        throw new GitError("dirty_worktree", "Worktree has uncommitted changes");
      }
    }
    // No JS recursive deletion. Git owns removal of this exact registered root.
    await repository.cli.call(
      root,
      ["worktree", "remove", ...(options.force ? ["--force"] : []), "--", found.path],
      { write: true },
    );
  });
}
