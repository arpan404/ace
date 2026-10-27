import type { Repository } from "./repository.ts";
import { commitChanges, pushBranch } from "./actions.ts";
import { inspectWorktreeCleanup } from "./worktree-cleanup.ts";
import { GitError } from "./types.ts";

/** Host opt-in backs up settled work using the user's Git identity and credential helpers. */
export async function backupWorktree(
  repository: Repository,
  repo: string,
  path: string,
  check: () => void,
): Promise<string | null> {
  return repository.cli.nonExecuting(async () => {
    const state = await inspectWorktreeCleanup(repository, repo, path);
    check();
    if (state.main || state.locked || state.missing)
      throw new GitError("invalid_argument", "Worktree cannot be backed up");
    if (state.mergedIntoMain && !state.dirty) return null;
    // Already published: skip the network call and any credential prompt it would trigger.
    if (!state.dirty && !state.unpushed) return state.head;
    const info = await repository.info(path);
    const origin = info.remotes.find((remote) => remote.name === "origin");
    if (!info.branch || ["main", "master"].includes(info.branch) || !origin?.pushUrls.length)
      throw new GitError("invalid_argument", "Backup needs a topic branch and origin remote");
    let head = info.head;
    if (state.dirty) {
      head = await commitChanges(repository, {
        worktree: path,
        expectedHead: head,
        message: "Back up settled worktree",
        beforeCommit: check,
      });
    }
    check();
    await pushBranch(repository, {
      worktree: path,
      remote: "origin",
      destination: info.branch,
      expected: { branch: info.branch, head, pushUrls: origin.pushUrls },
      beforePush: check,
    });
    return head;
  });
}
