import { z } from "zod";
import type { Repository } from "./repository.ts";
import { GitError } from "./types.ts";
import { textOutput } from "./cli.ts";
import { statusWithoutHidingFlags } from "./temporary-index.ts";

/** Private host-owned worktree only. A receipt ref reconciles a crash after merge. */
export async function integrateRevision(
  repository: Repository,
  input: { worktree: string; revision: string; key: string },
): Promise<{ revision: string; conflict: string | null; trivial: boolean }> {
  const revision = z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .parse(input.revision);
  const key = z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)
    .parse(input.key);
  const root = await repository.root(input.worktree);
  return repository.serial(root, async () => {
    const receipt = `refs/ace/conductor/${key}`;
    const saved = await repository.cli.call(root, ["rev-parse", "--verify", receipt], {
      allowFailure: true,
    });
    if (saved.exitCode === 0)
      return { revision: await repository.commit(root, receipt), conflict: null, trivial: false };
    const status = await statusWithoutHidingFlags(repository, root);
    if (
      status.staged.length ||
      status.unstaged.length ||
      status.untracked.length ||
      status.conflicted.length
    )
      throw new GitError("dirty_worktree", "Deck integration worktree requires attention");
    await repository.commit(root, revision);
    const contained = await repository.cli.call(
      root,
      ["merge-base", "--is-ancestor", revision, "HEAD"],
      { allowFailure: true },
    );
    if (contained.exitCode !== 0) {
      if (contained.exitCode !== 1) throw new GitError("git_failed", contained.stderr);
      const merged = await repository.cli.call(
        root,
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgSign=false",
          "merge",
          "--no-ff",
          "--no-edit",
          revision,
        ],
        { write: true, allowFailure: true },
      );
      if (merged.exitCode !== 0) {
        const conflict = (merged.stderr || textOutput(merged) || "Integration failed").slice(
          0,
          16384,
        );
        const current = await statusWithoutHidingFlags(repository, root);
        if (current.conflicted.length)
          await repository.cli.call(root, ["merge", "--abort"], { write: true });
        else throw new GitError("git_failed", conflict);
        return { revision, conflict, trivial: false };
      }
    }
    const head = await repository.commit(root, "HEAD");
    await repository.cli.call(root, ["update-ref", receipt, head], { write: true });
    return { revision: head, conflict: null, trivial: false };
  });
}
