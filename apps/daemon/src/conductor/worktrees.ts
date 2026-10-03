import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { GitService } from "@ace/git";
import type { RootBinding, LaneBinding } from "./journal.ts";

export class DeckWorktrees {
  readonly git: GitService;
  private directory: string;
  constructor(directory: string, now: () => number) {
    this.directory = directory;
    this.git = new GitService({ now: () => new Date(now()) });
  }
  async path(key: string) {
    await mkdir(join(this.directory, "deck-worktrees"), { recursive: true, mode: 0o700 });
    return join(await realpath(join(this.directory, "deck-worktrees")), key);
  }
  async ensure(root: RootBinding, tree: Pick<LaneBinding, "path" | "branch" | "base">) {
    const existing = (await this.git.listWorktrees(root.repo)).find(
      (entry) => entry.path === tree.path,
    );
    if (existing) {
      if (existing.branch !== tree.branch) throw new Error("deck_worktree_identity_changed");
      return;
    }
    let reuseBranch = false;
    try {
      const head = await this.git.resolveCommit({
        worktree: root.repo,
        ref: `refs/heads/${tree.branch}`,
      });
      if (head !== tree.base) throw new Error("deck_branch_identity_changed");
      reuseBranch = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "invalid_ref")) throw error;
    }
    await this.git.createWorktree({
      repo: root.repo,
      path: tree.path,
      branch: tree.branch,
      baseRef: tree.base,
      reuseBranch,
    });
  }
  close() {
    return this.git.close();
  }
}
