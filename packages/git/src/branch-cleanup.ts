import { z } from "zod";
import { textOutput } from "./cli.ts";
import type { Repository } from "./repository.ts";
import { GitError } from "./types.ts";

const Cleanup = z.object({
  repo: z.string().min(1).max(4096),
  branch: z.string().min(1).max(256),
  expectedHead: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
});
export type BranchCleanup = z.infer<typeof Cleanup>;
export async function deleteBranch(repository: Repository, value: BranchCleanup): Promise<void> {
  const options = Cleanup.parse(value),
    root = await repository.root(options.repo);
  await repository.serial(root, () => deleteUnchangedBranch(repository, root, options));
}

/** The caller already holds the repository lock during creation rollback. */
export async function deleteUnchangedBranch(
  repository: Repository,
  root: string,
  options: BranchCleanup,
): Promise<void> {
  const ref = `refs/heads/${options.branch}`;
  const valid = await repository.cli.call(root, ["check-ref-format", ref], {
    allowFailure: true,
  });
  if (options.branch.startsWith("-") || valid.exitCode !== 0)
    throw new GitError("invalid_ref", "Invalid cleanup branch");
  const current = await repository.cli.call(root, ["show-ref", "--verify", "--hash", ref], {
    allowFailure: true,
  });
  if (current.exitCode !== 0) return;
  if (textOutput(current) !== options.expectedHead)
    throw new GitError("restore_collision", "Cleanup branch changed");
  if ((await repository.worktrees(root)).some((tree) => tree.branch === options.branch))
    throw new GitError("restore_collision", "Cleanup branch is still checked out");
  // Compare-and-delete prevents a changed ref being removed between observation and mutation.
  await repository.cli.call(root, ["update-ref", "-d", ref, options.expectedHead], {
    write: true,
  });
}
