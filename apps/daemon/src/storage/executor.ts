import { StorageRefusal } from "./refusal.ts";
import { executeWorktreeCleanup } from "./worktree-executor.ts";
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
    case "skill_root":
      await inventory.files.removeSkillRoot(target.name);
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
    case "worktree":
      return executeWorktreeCleanup(owner, inventory, entry, allowed);
  }
}

export function fenceStorageItem(
  owner: StorageOwner,
  inventory: StorageInventory,
  planId: string,
  entry: ReviewedStorageItem,
): void {
  const { store } = owner;
  store.atomic(() => {
    let ids = entry.item.threadIds.map((id) => ThreadId.parse(id));
    if (entry.target.type === "worktree") {
      const created = inventory.managed.get(entry.target.path);
      if (!created || created.removed || created.repo !== entry.target.repo)
        throw new StorageRefusal("owner_unavailable");
      const repository = store.workspaceReservations.repository(entry.target.path);
      if (
        repository &&
        store.workspaceReservations.repositoryReserved(repository) &&
        !store.workspaceReservations.ownsRepositoryReservation(repository, `storage:${planId}`)
      )
        throw new StorageRefusal("cleanup_in_progress");
      // Fence root admission before the first asynchronous Git or filesystem inspection.
      try {
        store.workspaceReservations.reserve(
          ThreadId.parse(`storage:${planId}`),
          CommandId.parse(`storage:${planId}`),
          [entry.target.path],
        );
      } catch (error) {
        if (error instanceof Error && error.message === "workspace_change_in_progress")
          throw new StorageRefusal("cleanup_in_progress");
        throw error;
      }
      ids = inventory.worktreeOwners(entry.target.path);
    }
    const members = new Set(ids.flatMap((id) => storageTree(store, id)));
    for (const member of members) {
      const existing = store
        .statement("SELECT plan_id FROM storage_cleanup_fences WHERE thread_id=?")
        .get(member);
      if (existing && existing.plan_id !== planId) throw new StorageRefusal("cleanup_in_progress");
      store
        .statement("INSERT OR IGNORE INTO storage_cleanup_fences VALUES (?,?)")
        .run(member, planId);
    }
  });
}
