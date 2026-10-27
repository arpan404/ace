import type { ManagedWorktrees, ManagedWorktree } from "../managed-worktrees.ts";

/** Each automatic operation owns its cursor. Manual scans never advance it. */
export class WorktreeBatches {
  private after = "";
  next(managed: ManagedWorktrees): ManagedWorktree[] {
    const records = managed.listAfter(this.after);
    const batch = records.slice(0, 256);
    this.after = records.length > 256 ? (batch.at(-1)?.path ?? "") : "";
    return batch;
  }
}
