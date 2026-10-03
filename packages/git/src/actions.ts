import { z } from "zod";
import type { Repository } from "./repository.ts";
import { serial } from "./lock.ts";
import { GitError } from "./types.ts";
const head = z.string().regex(/^[a-f0-9]{40,64}$/);
export async function commitChanges(
  repository: Repository,
  options: { worktree: string; message: string; expectedHead: string | null },
): Promise<string> {
  const message = z.string().trim().min(1).max(8192).parse(options.message);
  const expected = head.nullable().parse(options.expectedHead);
  const root = await repository.root(options.worktree);
  return serial(root, async () => {
    const info = await repository.info(root);
    if (info.head !== expected)
      throw new GitError("head_moved", "HEAD changed; refresh before committing");
    const status = await repository.status(root);
    if (status.conflicted.length)
      throw new GitError("conflicts", "Resolve conflicts before committing");
    await repository.cli.call(root, ["add", "--all", "--", "."], {
      write: true,
      captureBytes: 65536,
    });
    await repository.cli.call(root, ["commit", "--file=-"], {
      write: true,
      input: message,
      captureBytes: 65536,
      env: { GIT_TRACE2_EVENT: "1" },
    });
    return head.parse(await repository.commit(root, "HEAD"));
  });
}
export async function pushBranch(
  repository: Repository,
  options: { worktree: string; remote: string },
): Promise<void> {
  const remote = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\w./-]+$/)
    .refine((value) => !value.startsWith("-"))
    .parse(options.remote);
  const root = await repository.root(options.worktree);
  await serial(root, async () => {
    const info = await repository.info(root);
    if (!info.branch || !info.remotes.some((entry) => entry.name === remote))
      throw new GitError("invalid_argument", "Select a branch and an existing remote");
    await repository.cli.call(
      root,
      ["push", "--set-upstream", "--", remote, `HEAD:refs/heads/${info.branch}`],
      { write: true, captureBytes: 65536, env: { GIT_TRACE2_EVENT: "1" } },
    );
  });
}
export async function switchBranch(
  repository: Repository,
  options: { worktree: string; branch: string; allowUncommitted: boolean },
): Promise<void> {
  const root = await repository.root(options.worktree);
  await serial(root, async () => {
    const valid = await repository.cli.call(
      root,
      ["check-ref-format", "--branch", options.branch],
      { allowFailure: true },
    );
    if (!options.branch || options.branch.startsWith("-") || valid.exitCode !== 0)
      throw new GitError("invalid_ref", "Invalid branch");
    const status = await repository.status(root);
    if (status.conflicted.length)
      throw new GitError("conflicts", "Resolve conflicts before switching");
    if (
      !options.allowUncommitted &&
      (status.staged.length || status.unstaged.length || status.untracked.length)
    )
      throw new GitError("dirty_worktree", "Commit or explicitly allow uncommitted changes");
    await repository.cli.call(root, ["switch", "--no-guess", "--", options.branch], {
      write: true,
      env: { GIT_TRACE2_EVENT: "1" },
    });
  });
}
export async function listBranches(
  repository: Repository,
  worktree: string,
): Promise<{ branches: string[]; truncated: boolean }> {
  const root = await repository.root(worktree);
  const result = await repository.cli.call(
    root,
    ["for-each-ref", "--count=1001", "--format=%(refname:short)", "refs/heads", "refs/remotes"],
    { captureBytes: 1_048_576 },
  );
  const branches = z
    .array(z.string().min(1).max(1024))
    .max(1001)
    .parse(result.stdout.toString("utf8").trim().split("\n").filter(Boolean));
  return { branches: branches.slice(0, 1000), truncated: branches.length > 1000 };
}
