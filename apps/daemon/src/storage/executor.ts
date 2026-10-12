import { CommandId, ThreadId } from "@ace/protocol";
import type { StorageOwner, ReviewedStorageItem } from "./types.ts";
import type { StorageInventory } from "./inventory.ts";
import { hasTable, storageProtections, storageTree } from "./ownership.ts";

/** The journal commits "running" and admission fences before this shell performs effects. */
export async function executeStorageItem(
  owner: StorageOwner,
  inventory: StorageInventory,
  entry: ReviewedStorageItem,
  allowed: () => boolean,
): Promise<void> {
  if (!allowed()) throw new Error("storage_forbidden");
  const { store, services, now } = owner;
  const target = entry.target;
  switch (target.type) {
    case "file":
      inventory.files.remove(target.path, entry.item.kind, entry.fingerprint);
      return;
    case "attachment":
      if (!services.context) throw new Error("storage_context_unavailable");
      await services.context.uploads.removeCleanup(target.hash, entry.fingerprint);
      return;
    case "thread": {
      const id = ThreadId.parse(target.threadId);
      if (store.statement("SELECT 1 FROM storage_purged WHERE thread_id=?").get(id)) return;
      const thread = store.getThread(id);
      if (!thread) return;
      if (storageProtections(owner, [id]).length) throw new Error("storage_item_changed");
      if (services.engine) await services.engine.stopForDeletion(id);
      else if (hasTable(store, "engine_sessions")) throw new Error("storage_engine_unavailable");
      if (!allowed() || storageProtections(owner, [id]).length)
        throw new Error("storage_item_changed");
      await store.writable();
      if (store.getThread(id)?.deletedAt === undefined)
        store.appendEvents(
          id,
          [{ type: "thread.client.updated", changes: { deletedAt: now(), autoSettleAt: null } }],
          now(),
        );
      if (!services.context) throw new Error("storage_context_unavailable");
      await services.context.uploads.releaseThread(id);
      if (!allowed()) throw new Error("storage_forbidden");
      await store.writable();
      store.atomic(() => {
        store.purgeThreadData(id);
        store.statement("INSERT OR REPLACE INTO storage_purged VALUES (?,?)").run(id, now());
      });
      return;
    }
    case "worktree": {
      const workspace = services.workspaceActions;
      if (!workspace) throw new Error("storage_git_unavailable");
      if (
        storageProtections(
          owner,
          entry.item.threadIds.map((id) => ThreadId.parse(id)),
        ).length
      )
        throw new Error("storage_item_changed");
      for (const raw of entry.item.threadIds)
        await services.engine?.stopForDeletion(ThreadId.parse(raw));
      const trees = await workspace.git.nonExecuting(() =>
        workspace.git.listWorktrees(target.repo),
      );
      if (
        !allowed() ||
        storageProtections(
          owner,
          entry.item.threadIds.map((id) => ThreadId.parse(id)),
        ).length
      )
        throw new Error("storage_item_changed");
      if (trees.some((tree) => tree.path === target.path)) {
        await workspace.git.cleanupWorktree({
          repo: target.repo,
          path: target.path,
          fingerprint: target.gitFingerprint,
          force: entry.item.forced,
          removeBranch: entry.item.removeBranch ?? false,
        });
      } else if (entry.item.removeBranch && target.branch && target.head) {
        // A crash may have removed the checkout before compare-and-deleting its branch.
        await workspace.git.nonExecuting(() =>
          workspace.git.deleteBranch({
            repo: target.repo,
            branch: target.branch ?? "",
            expectedHead: target.head ?? "",
          }),
        );
      }
      store
        .statement("INSERT OR REPLACE INTO storage_removed_roots VALUES (?,?)")
        .run(target.path, now());
      return;
    }
  }
}

export function fenceStorageItem(
  owner: StorageOwner,
  planId: string,
  entry: ReviewedStorageItem,
): void {
  const { store } = owner;
  const members = new Set(
    entry.item.threadIds.flatMap((id) => storageTree(store, ThreadId.parse(id))),
  );
  store.atomic(() => {
    for (const member of members) {
      const existing = store
        .statement("SELECT plan_id FROM storage_cleanup_fences WHERE thread_id=?")
        .get(member);
      if (existing && existing.plan_id !== planId) throw new Error("storage_cleanup_busy");
      store
        .statement("INSERT OR IGNORE INTO storage_cleanup_fences VALUES (?,?)")
        .run(member, planId);
    }
    if (entry.target.type === "worktree")
      store.workspaceReservations.reserve(
        ThreadId.parse(`storage:${planId}`),
        CommandId.parse(`storage:${planId}`),
        [entry.target.path],
      );
  });
}
