import { worktreeFootprint } from "./worktree-footprint.ts";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { deleteUnchangedBranch } from "./branch-cleanup.ts";
import { textOutput } from "./cli.ts";
import { ignoredPaths } from "./nested.ts";
import { statusWithoutHidingFlags } from "./temporary-index.ts";
import type { Repository } from "./repository.ts";
import { GitError } from "./types.ts";

/** Emitted only by assertions before worktree remove is dispatched. */
export class WorktreeRemovalRefused extends GitError {}

export interface WorktreeCleanupState {
  path: string;
  head: string | null;
  branch: string | null;
  fingerprint: string;
  bytes: number;
  modifiedAt: number;
  missing: boolean;
  main: boolean;
  locked: boolean;
  dirty: boolean;
  unpushed: boolean;
}
const Input = z.object({
  repo: z.string().min(1).max(4096),
  path: z.string().min(1).max(4096),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  force: z.boolean(),
  removeBranch: z.boolean(),
});
export type WorktreeCleanupInput = z.infer<typeof Input>;

/** Caller holds the common repository lock. Policy is established before even discovering roots. */
async function inspect(
  repository: Repository,
  root: string,
  path: string,
): Promise<WorktreeCleanupState> {
  const trees = await repository.worktrees(root);
  const tree = trees.find((entry) => resolve(entry.path) === resolve(path));
  if (!tree) throw new GitError("worktree_not_found", "Worktree is no longer registered");
  let missing = false;
  let identity: string | undefined;
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== resolve(path))
      throw new GitError("invalid_argument", "Cleanup requires an exact physical worktree");
    identity = `${info.dev}:${info.ino}`;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    missing = true;
  }
  let dirty = false;
  let unpushed = true;
  let status: unknown;
  let ignored: string[] = [];
  if (!missing) {
    status = await statusWithoutHidingFlags(repository, path);
    const parsed = z
      .object({
        staged: z.array(z.unknown()),
        unstaged: z.array(z.unknown()),
        conflicted: z.array(z.unknown()),
        untracked: z.array(z.string()),
      })
      .parse(status);
    ignored = await ignoredPaths(repository, path);
    dirty = Object.values(parsed).some((entries) => entries.length > 0) || ignored.length > 0;
  }
  // Local remote-tracking evidence only. No network or executable repository configuration.
  if (tree.head) {
    const unpublished = await repository.cli.call(root, [
      "rev-list",
      "--count",
      tree.head,
      "--not",
      "--remotes",
    ]);
    unpushed = z.coerce.number().int().nonnegative().parse(textOutput(unpublished)) > 0;
  }
  const footprint = missing
    ? { bytes: 0, modifiedAt: 0, digest: "missing" }
    : await worktreeFootprint(path);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ tree, identity, status, ignored, unpushed, footprint }))
    .digest("hex");
  return {
    bytes: footprint.bytes,
    modifiedAt: footprint.modifiedAt,
    path: tree.path,
    head: tree.head,
    branch: tree.branch,
    fingerprint,
    missing,
    main: trees[0]?.path === tree.path || tree.bare,
    locked: tree.locked !== null,
    dirty,
    unpushed,
  };
}

export function worktreeMetadata(repository: Repository, repo: string, path: string) {
  return repository.cli.nonExecuting(async () => {
    const root = await repository.root(repo);
    return repository.serial(root, async () => {
      if (!(await repository.worktrees(root)).some((tree) => tree.path === path))
        throw new GitError("worktree_not_found", "Worktree is not registered");
      const metadata = await realpath(
        textOutput(await repository.cli.call(path, ["rev-parse", "--absolute-git-dir"])),
      );
      const info = await lstat(metadata);
      return { path: metadata, dev: info.dev, ino: info.ino };
    });
  });
}

export function inspectWorktreeCleanup(repository: Repository, repo: string, path: string) {
  return repository.cli.nonExecuting(async () => {
    const root = await repository.root(repo);
    return repository.serial(root, () => inspect(repository, root, path));
  });
}

/** Exact worktree and branch only; never broad prune, shell commands or recursive JS deletion. */
export function cleanupWorktree(
  repository: Repository,
  input: WorktreeCleanupInput,
  beforeRemove: () => void = () => {},
): Promise<void> {
  const value = Input.parse(input);
  return repository.cli.nonExecuting(async () => {
    const root = await repository.root(value.repo);
    return repository.serial(root, async () => {
      const remove = async () => {
        const state = await inspect(repository, root, value.path);
        if (state.fingerprint !== value.fingerprint)
          throw new WorktreeRemovalRefused("head_moved", "Cleanup plan changed");
        if (state.main)
          throw new WorktreeRemovalRefused("main_worktree", "Main worktree is protected");
        if (state.locked)
          throw new WorktreeRemovalRefused("dirty_worktree", "Locked worktree is protected");
        if (!value.force && (state.dirty || state.unpushed))
          throw new WorktreeRemovalRefused(
            "dirty_worktree",
            "Worktree contains uncommitted or unpublished work",
          );
        await repository.cli.call(
          root,
          ["worktree", "remove", ...(value.force ? ["--force"] : []), "--", state.path],
          { write: true, beforeSpawn: beforeRemove },
        );
        if (value.removeBranch && state.branch && state.head)
          await deleteUnchangedBranch(repository, root, {
            repo: root,
            branch: state.branch,
            expectedHead: state.head,
          });
        repository.cli.forgetWorktree(state.path);
      };
      // Missing entries have no checkout to lock; common metadata still owns the mutation.
      const state = await inspect(repository, root, value.path);
      if (state.main)
        throw new WorktreeRemovalRefused("main_worktree", "Main worktree is protected");
      if (state.missing) await remove();
      else await repository.serial(state.path, remove);
    });
  });
}
