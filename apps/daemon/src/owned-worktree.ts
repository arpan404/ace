import { GitError, type GitService } from "@ace/git";

export type OwnedWorktreeGit = Pick<
  GitService,
  "listWorktrees" | "removeWorktree" | "deleteBranch" | "resolveCommit"
>;
export interface OwnedWorktree {
  repo: string;
  path: string;
  branch: string;
  baseHead: string;
  cleanupHead: string | null;
  uncertain: boolean;
}
/** Shared cleanup authority for creation and handoff journals. Preserve external edits/commits. */
export async function cleanupOwnedWorktree(
  git: OwnedWorktreeGit,
  resource: OwnedWorktree,
  saveHead: (head: string) => void,
): Promise<void> {
  const tree = (await git.listWorktrees(resource.repo)).find(
    (candidate) => candidate.path === resource.path,
  );
  if (tree) {
    if (tree.branch !== resource.branch || tree.head !== resource.baseHead)
      throw new Error("Worktree cleanup identity changed");
    saveHead(resource.baseHead);
    resource.cleanupHead = resource.baseHead;
    await git.removeWorktree({ repo: resource.repo, path: resource.path });
  }
  if (!tree && !resource.cleanupHead && resource.uncertain) {
    let exists = false;
    try {
      await git.resolveCommit({ worktree: resource.repo, ref: `refs/heads/${resource.branch}` });
      exists = true;
    } catch (error) {
      if (!(error instanceof GitError && error.code === "invalid_ref")) throw error;
    }
    if (exists) throw new Error("Incomplete Git creation requires cleanup");
  }
  if (resource.cleanupHead)
    await git.deleteBranch({
      repo: resource.repo,
      branch: resource.branch,
      expectedHead: resource.cleanupHead,
    });
}
