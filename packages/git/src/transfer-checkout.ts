import { lstat } from "node:fs/promises";
import { longWriteTimeoutMs } from "./deadlines.ts";
import type { Repository } from "./repository.ts";
import { landingBranchName, type LandingBranch } from "./transfer-branch-name.ts";
import { assertBranchName, refsUnder } from "./transfer-refs.ts";
import { GitError } from "./types.ts";
import { createWorktree } from "./worktrees.ts";

export interface CheckoutState {
  /** No staged, unstaged or conflicted tracked changes and no untracked non-ignored files. */
  clean: boolean;
  branch?: string;
  head?: string;
}

export async function checkoutState(repository: Repository, root: string): Promise<CheckoutState> {
  const { status, branch } = await repository.state(root);
  const clean =
    !status.staged.length &&
    !status.unstaged.length &&
    !status.untracked.length &&
    !status.conflicted.length;
  return {
    clean,
    ...(branch.branch && !branch.detached ? { branch: branch.branch } : {}),
    ...(branch.head ? { head: branch.head } : {}),
  };
}

async function assertClean(repository: Repository, root: string): Promise<void> {
  if (!(await checkoutState(repository, root)).clean)
    throw new GitError("dirty_worktree", "The checkout has uncommitted changes");
}

/** In a clean checkout, point branch `name` at `commit` (creating or resetting it) and switch. */
export async function checkoutBranch(
  repository: Repository,
  root: string,
  options: { name: string; commit: string },
): Promise<void> {
  await assertBranchName(repository, root, options.name);
  const sha = await repository.commit(root, options.commit);
  await assertClean(repository, root);
  const result = await repository.cli.call(
    root,
    ["switch", "--quiet", "--no-guess", "--no-track", "-C", options.name, sha],
    { write: true, allowFailure: true, timeoutMs: longWriteTimeoutMs },
  );
  if (result.exitCode === 0) return;
  if (/already (?:checked out|used by worktree)/i.test(result.stderr))
    throw new GitError("branch_checked_out", `${options.name} is checked out in another worktree`);
  throw new GitError("git_failed", `Could not switch to ${options.name}`, {
    stderr: result.stderr,
  });
}

/**
 * Move the checked-out branch forward to `commit`. `head_moved` (details.reason
 * `not_fast_forward`) when the branch has commits `commit` lacks; `dirty_worktree` when the
 * checkout's own changes are in the way.
 */
export async function fastForward(
  repository: Repository,
  root: string,
  commit: string,
): Promise<void> {
  const sha = await repository.commit(root, commit);
  const result = await repository.cli.call(
    root,
    ["merge", "--ff-only", "--quiet", "--no-autostash", "--no-stat", sha],
    { write: true, allowFailure: true, timeoutMs: longWriteTimeoutMs },
  );
  if (result.exitCode === 0) return;
  if (/not possible to fast-forward|diverging branches/i.test(result.stderr))
    throw new GitError("head_moved", "The branch has commits the transfer doesn't", {
      reason: "not_fast_forward",
    });
  if (/would be overwritten|untracked working tree files/i.test(result.stderr))
    throw new GitError("dirty_worktree", "The checkout's own changes are in the way");
  throw new GitError("git_failed", "Could not fast-forward", { stderr: result.stderr });
}

/** A linked worktree at `path` (which must not exist) on the existing local `branch`. */
export async function addBranchWorktree(
  repository: Repository,
  repo: string,
  options: { path: string; branch: string },
) {
  if (await lstat(options.path).catch(() => undefined))
    throw new GitError("path_exists", "The worktree folder already exists");
  const root = await repository.root(repo);
  const heads = await refsUnder(repository, root, [`refs/heads/${options.branch}`]);
  if (!heads.has(`refs/heads/${options.branch}`))
    throw new GitError("invalid_ref", `No local branch ${options.branch}`);
  return createWorktree(repository, {
    repo: root,
    path: options.path,
    baseRef: `refs/heads/${options.branch}`,
    branch: options.branch,
    reuseBranch: true,
  });
}

/** The local branch name a transferred `branch` at `commit` lands under (see `landingBranchName`). */
export async function landingBranch(
  repository: Repository,
  root: string,
  options: { branch: string; commit: string; machine: string },
): Promise<LandingBranch> {
  await assertBranchName(repository, root, options.branch);
  const commit = await repository.commit(root, options.commit);
  const refs = await refsUnder(repository, root, ["refs/heads"]);
  const heads = new Map(
    [...refs].map(([ref, sha]) => [ref.slice("refs/heads/".length), sha] as const),
  );
  return landingBranchName({ ...options, commit, heads });
}
