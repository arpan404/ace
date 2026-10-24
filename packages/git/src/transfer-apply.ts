import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { textOutput } from "./cli.ts";
import { hash } from "./decode.ts";
import { longWriteTimeoutMs } from "./deadlines.ts";
import type { Repository } from "./repository.ts";
import { GitError } from "./types.ts";

/**
 * Put the changes a captured transfer commit holds (its diff against its parent: edits,
 * deletions, new and binary files, renames, modes) into the checkout as uncommitted changes.
 * HEAD, the branch and the index stay as they are. A checkout whose own changes touch the same
 * files is refused with `dirty_worktree` before anything is written.
 */
export async function applyChanges(
  repository: Repository,
  root: string,
  commit: string,
): Promise<void> {
  const { cli } = repository;
  const sha = await repository.commit(root, commit);
  const parent = await cli.call(root, ["rev-parse", "--verify", "--quiet", `${sha}^1`], {
    allowFailure: true,
  });
  const base =
    parent.exitCode === 0
      ? hash(textOutput(parent))
      : hash(
          textOutput(await cli.call(root, ["hash-object", "-t", "tree", "--stdin"], { input: "" })),
        );
  const directory = await mkdtemp(join(repository.tempDirectory, "ace-git-transfer-"));
  try {
    const patch = join(directory, "changes.patch");
    await cli.call(root, [
      "diff",
      "--binary",
      "--full-index",
      "--find-renames",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-relative",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      `--output=${patch}`,
      base,
      sha,
      "--",
    ]);
    if ((await stat(patch)).size === 0) return;
    const apply = ["apply", "--binary", "--whitespace=nowarn"];
    const check = await cli.call(root, [...apply, "--check", patch], { allowFailure: true });
    if (check.exitCode !== 0)
      throw new GitError(
        "dirty_worktree",
        "The checkout has changes to the same files as the transferred ones",
        { stderr: check.stderr },
      );
    await cli.call(root, [...apply, patch], { write: true, timeoutMs: longWriteTimeoutMs });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
