import { WorktreeRemovalRefused } from "@ace/git";
import type { StorageApply } from "@ace/protocol";
import type { StorageOwner } from "./types.ts";
import type { StorageInventory } from "./inventory.ts";
import type { StorageJournal, CleanupJournal } from "./journal.ts";
import { planStorageItem } from "./planner.ts";
import { executeStorageItem, fenceStorageItem } from "./executor.ts";
import { StorageRefusal } from "./refusal.ts";
import { compactStorage } from "./compaction.ts";

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
function release(owner: StorageOwner, id: string): void {
  owner.store.statement("DELETE FROM storage_cleanup_fences WHERE plan_id=?").run(id);
  owner.store.workspaceReservations.release(`storage:${id}`);
}

export async function applyStorageItems(
  owner: StorageOwner,
  inventory: StorageInventory,
  journal: StorageJournal,
  state: CleanupJournal,
  allowed: () => boolean,
): Promise<StorageApply> {
  owner.cleanupPlanId = state.plan.id;
  try {
    for (const entry of state.entries) {
      if (!allowed()) break;
      if (entry.item.disposition !== "remove" || ["removed", "protected"].includes(entry.state))
        continue;
      try {
        await owner.store.writable();
        // Root and current family fences commit before asynchronous final inspection.
        owner.store.atomic(() => {
          fenceStorageItem(owner, inventory, state.plan.id, entry);
          journal.save(state);
        });
        const current = await inventory
          .inspect(entry.target, entry.item.kind)
          .catch((error: unknown) => {
            if (
              missing(error) ||
              (error instanceof Error && "code" in error && error.code === "worktree_not_found")
            )
              return undefined;
            throw error;
          });
        const item =
          current &&
          planStorageItem(
            current,
            state.plan.retention,
            owner.now(),
            new Set(entry.item.forced ? [entry.item.id] : []),
          );
        if (
          (item?.disposition === "protect" &&
            !(
              entry.state === "running" &&
              entry.target.type === "thread" &&
              item.reasons.every((reason) => reason === "within_retention")
            )) ||
          (!current && entry.state === "pending") ||
          (current &&
            current.fingerprint !== entry.fingerprint &&
            (entry.state === "pending" || entry.target.type === "worktree"))
        )
          throw new StorageRefusal(
            item?.disposition === "protect" ? (item.reasons[0] ?? "changed") : "changed",
          );
        if (
          !current &&
          entry.target.type === "worktree" &&
          inventory.managed.verify(entry.target.repo, entry.target.path)
        )
          throw new StorageRefusal("changed");
        entry.state = "running";
        journal.save(state);
        await executeStorageItem(owner, inventory, entry, allowed);
        await owner.afterRemove?.(entry.item.id);
        entry.state = "removed";
        delete entry.error;
      } catch (error) {
        if (error instanceof StorageRefusal || error instanceof WorktreeRemovalRefused) {
          entry.state = "protected";
          entry.reason = error instanceof StorageRefusal ? error.reason : "changed";
          delete entry.error;
        } else if (missing(error) && entry.target.type === "file") {
          entry.state = "removed";
          entry.reason = "already_removed";
        } else {
          const code =
            error instanceof Error && "code" in error && typeof error.code === "string"
              ? error.code
              : undefined;
          entry.error = code?.match(/^[a-z_]{1,128}$/) ? code : "cleanup_pending";
          journal.save(state);
          return journal.result(state);
        }
      }
      owner.store.atomic(() => {
        journal.save(state);
        release(owner, state.plan.id);
      });
    }
    if (
      state.entries.some(
        (entry) =>
          entry.item.disposition === "remove" && ["pending", "running"].includes(entry.state),
      )
    )
      return journal.result(state);
    if (state.compact) state.compaction = allowed() ? await compactStorage(owner) : "deferred";
    state.state = "complete";
    journal.save(state);
    return journal.result(state);
  } finally {
    delete owner.cleanupPlanId;
  }
}
