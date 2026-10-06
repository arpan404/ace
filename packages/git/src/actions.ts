import { z } from "zod";
import type { Repository } from "./repository.ts";
import { GitError } from "./types.ts";
const head = z.string().regex(/^[a-f0-9]{40,64}$/);
/** Pathspec bytes one commit may name: well inside every platform's argument limit. */
const maxPathBytes = 256 * 1024;
const commitPaths = z
  .array(
    z
      .string()
      .min(1)
      .max(4096)
      .refine((path) => !path.includes("\0")),
  )
  .min(1)
  // 500 listed files, each a rename naming two paths.
  .max(1000)
  .refine(
    (paths) => paths.reduce((sum, path) => sum + Buffer.byteLength(path) + 1, 0) <= maxPathBytes,
  );

/**
 * Commit the checkout: every change, or only `paths` (repository-relative, taken literally).
 * With paths, other changes stay as they were, staged or not.
 */
export async function commitChanges(
  repository: Repository,
  options: {
    worktree: string;
    message: string;
    expectedHead: string | null;
    paths?: readonly string[] | undefined;
  },
): Promise<string> {
  const message = z.string().trim().min(1).max(8192).parse(options.message);
  const expected = head.nullable().parse(options.expectedHead);
  const paths = options.paths === undefined ? undefined : commitPaths.safeParse(options.paths);
  if (paths && !paths.success)
    throw new GitError("invalid_argument", "Name between 1 and 1000 paths to commit");
  const root = await repository.root(options.worktree);
  return repository.serial(root, async () => {
    const info = await repository.info(root);
    if (info.head !== expected)
      throw new GitError("head_moved", "HEAD changed; refresh before committing");
    const status = await repository.status(root);
    if (status.conflicted.length)
      throw new GitError("conflicts", "Resolve conflicts before committing");
    // Literal pathspecs: a file named "*.ts" or ":(glob)x" means that file.
    const literal = { GIT_LITERAL_PATHSPECS: "1" };
    const named = paths ? [...new Set(paths.data)] : ["."];
    // Stage what the working tree changed among them; a path already staged (a rename's old
    // name, a staged deletion) is in no worktree and `git add` would refuse it.
    const changed = new Set([...status.unstaged.map((entry) => entry.path), ...status.untracked]);
    const staging = paths ? named.filter((path) => changed.has(path)) : named;
    if (staging.length)
      await repository.cli.call(root, ["add", "--all", "--", ...staging], {
        write: true,
        captureBytes: 65536,
        env: literal,
      });
    await repository.cli.call(
      root,
      ["commit", "--file=-", ...(paths ? ["--only", "--", ...named] : [])],
      {
        write: true,
        input: message,
        captureBytes: 65536,
        env: { GIT_TRACE2_EVENT: "1", ...literal },
      },
    );
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
  await repository.serial(root, async () => {
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
  await repository.serial(root, async () => {
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
