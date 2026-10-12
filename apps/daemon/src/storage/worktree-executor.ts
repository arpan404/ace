import { WorktreeRemovalRefused } from "@ace/git";
import type { StorageOwner, ReviewedStorageItem } from "./types.ts";
import type { StorageInventory } from "./inventory.ts";
import { StorageRefusal } from "./refusal.ts";

export async function executeWorktreeCleanup(
  owner: StorageOwner,
  inventory: StorageInventory,
  entry: ReviewedStorageItem,
  allowed: () => boolean,
): Promise<void> {
  const target = entry.target;
  if (target.type !== "worktree") throw new Error("invalid_storage_target");
  const workspace = owner.services.workspaceActions;
  if (!workspace) throw new StorageRefusal("owner_unavailable");
  const current = inventory.worktreeOwnership(target.path);
  if (current.protections.length) throw new StorageRefusal(current.protections[0] ?? "changed");
  const created = inventory.managed.get(target.path);
  if (!created || created.repo !== target.repo || created.removed)
    throw new StorageRefusal("owner_unavailable");
  // Closing a retained actor is permitted only after fresh owners prove it has no live session/work.
  for (const id of current.ids) await owner.services.engine?.stopForDeletion(id);
  const trees = await workspace.git.nonExecuting(() => workspace.git.listWorktrees(target.repo));
  const check = () => {
    if (
      !allowed() ||
      inventory.worktreeOwnership(target.path).protections.length ||
      !inventory.managed.verify(target.repo, target.path)
    )
      throw new WorktreeRemovalRefused("head_moved", "Cleanup ownership changed before removal");
  };
  if (trees.some((tree) => tree.path === target.path)) {
    check();
    await workspace.git.cleanupWorktree(
      {
        repo: target.repo,
        path: target.path,
        fingerprint: target.gitFingerprint,
        force: entry.item.forced,
        removeBranch: entry.item.removeBranch ?? false,
      },
      check,
    );
  } else {
    // Resume only our own accepted removal; an unstarted missing target invalidates its plan.
    if (entry.state !== "running" || !inventory.managed.repositoryMatches(created))
      throw new StorageRefusal("changed");
    if (target.branch && target.head && entry.item.removeBranch)
      await workspace.git.nonExecuting(() =>
        workspace.git.deleteBranch({
          repo: target.repo,
          branch: target.branch ?? "",
          expectedHead: target.head ?? "",
        }),
      );
  }
  owner.store.atomic(() => {
    inventory.managed.removed(target.path);
    owner.store
      .statement("INSERT OR REPLACE INTO storage_removed_roots VALUES (?,?)")
      .run(target.path, owner.now());
  });
}
