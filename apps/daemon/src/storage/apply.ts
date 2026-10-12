import { WorktreeRemovalRefused } from "@ace/git";
import type { StorageApply } from "@ace/protocol";
import type { StorageOwner } from "./types.ts";
import type { StorageInventory } from "./inventory.ts";
import type { StorageJournal, CleanupJournal, CompactionJournal } from "./journal.ts";
import { planStorageItem } from "./planner.ts";
import { executeStorageItem, fenceStorageItem } from "./executor.ts";
import { StorageRefusal } from "./refusal.ts";

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
        } else if (
          missing(error) &&
          (entry.target.type === "file" || entry.target.type === "skill_root")
        ) {
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
    state.state = "complete";
    journal.save(state);
    return journal.result(state);
  } finally {
    delete owner.cleanupPlanId;
  }
}

export interface CompactionLimits {
  /** Free pages released per incremental_vacuum transaction. */
  chunkPages: number;
  /** Chunks per run; a larger backlog stays pending for the next resume. */
  maxChunks: number;
  /** Yields between chunks so held writers' waits and socket traffic stay bounded. */
  pause(): Promise<void>;
}

/**
 * Journaled compaction under the Store maintenance fence. Each chunk is its own SQLite
 * transaction and a full VACUUM is atomic, so a kill at any point leaves an intact file
 * and a running journal entry. Incremental work resumes; a full rebuild never restarts
 * without a new confirmation.
 */
export async function compactStorage(
  owner: StorageOwner,
  journal: StorageJournal,
  state: CompactionJournal,
  limits: CompactionLimits,
  allowed: () => boolean,
): Promise<void> {
  const save = () => journal.saveCompaction(state);
  await owner.store.maintenance(async (db) => {
    const pragma = (sql: string) => Number(Object.values(db.prepare(sql).get() ?? {})[0]);
    if (state.phase === "vacuum") {
      if (state.mode === "full") {
        if (!allowed()) return;
        // Converts files created before incremental vacuum; takes effect through VACUUM.
        db.exec("PRAGMA auto_vacuum=INCREMENTAL");
        await owner.afterCompactionStep?.();
        db.exec("VACUUM");
        state.fullRequired = false;
      } else {
        state.fullRequired = pragma("PRAGMA auto_vacuum") === 0;
        for (let chunk = 0; !state.fullRequired && chunk < limits.maxChunks; chunk++) {
          if (pragma("PRAGMA freelist_count") === 0) break;
          if (!allowed()) return;
          db.exec(`PRAGMA incremental_vacuum(${limits.chunkPages})`);
          state.chunks++;
          save();
          await owner.afterCompactionStep?.();
          await limits.pause();
        }
        if (!state.fullRequired && pragma("PRAGMA freelist_count") > 0) return;
      }
      state.phase = "checkpoint";
      save();
    }
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    state.checkpointed = Number(checkpoint?.busy) === 0;
    state.state = "complete";
    save();
    // The journal write above left a frame; truncate again so the WAL ends empty.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  });
}
