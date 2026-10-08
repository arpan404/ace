import { z } from "zod";
import type { Repository } from "./repository.ts";
import { GitError } from "./types.ts";
import { statusWithoutHidingFlags } from "./temporary-index.ts";

/** Private Deck worktree only. Restore the saved tree with a forward commit, never a force push. */
export async function rollbackIntegration(
  repository: Repository,
  input: { worktree: string; key: string; revision: string },
): Promise<string> {
  const key = z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)
    .parse(input.key);
  const revision = z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .parse(input.revision);
  const root = await repository.root(input.worktree);
  return repository.serial(root, async () => {
    const receipt = `refs/ace/conductor/${key}`;
    const saved = await repository.cli.call(
      root,
      ["rev-parse", "--verify", `${receipt}.rollback`],
      { allowFailure: true },
    );
    if (saved.exitCode === 0) {
      const reverted = await repository.commit(root, `${receipt}.rollback`);
      if ((await repository.commit(root, "HEAD")) !== reverted)
        throw new GitError("head_moved", "Deck branch changed after integration rollback");
      return reverted;
    }
    const base = await repository.commit(root, `${receipt}.base`);
    const head = await repository.commit(root, "HEAD");
    const restored = await repository.cli.call(root, ["diff", "--quiet", base, head, "--"], {
      allowFailure: true,
    });
    if (head !== revision && restored.exitCode !== 0)
      throw new GitError("head_moved", "Deck branch changed before integration rollback");
    const status = await statusWithoutHidingFlags(repository, root);
    const stagedRestore =
      status.staged.length > 0 &&
      head === revision &&
      (await repository.cli.call(root, ["write-tree"])).stdout.toString().trim() ===
        (await repository.cli.call(root, ["rev-parse", `${base}^{tree}`])).stdout.toString().trim();
    if (
      (status.staged.length && !stagedRestore) ||
      status.unstaged.length ||
      status.untracked.length ||
      status.conflicted.length
    )
      throw new GitError("dirty_worktree", "Deck rollback requires a clean host-owned worktree");
    if (restored.exitCode !== 0) {
      await repository.cli.call(
        root,
        ["restore", `--source=${base}`, "--staged", "--worktree", "--", "."],
        { write: true },
      );
      await repository.cli.call(
        root,
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgSign=false",
          "commit",
          "-m",
          `Revert unverified Deck integration ${key}`,
        ],
        { write: true },
      );
    }
    const reverted = await repository.commit(root, "HEAD");
    await repository.cli.call(root, ["update-ref", `${receipt}.rollback`, reverted], {
      write: true,
    });
    return reverted;
  });
}
