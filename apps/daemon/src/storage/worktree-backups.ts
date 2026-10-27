import { z } from "zod";
import { StorageUsage, ThreadId } from "@ace/protocol";
import type { StorageInventory } from "./inventory.ts";
import type { StorageOwner } from "./types.ts";
import { WorktreeBatches } from "./worktree-batches.ts";

export class WorktreeBackups {
  private owner: StorageOwner;
  private batches = new WorktreeBatches();
  constructor(owner: StorageOwner) {
    this.owner = owner;
    owner.store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS storage_worktree_backups(
      path TEXT PRIMARY KEY, result TEXT NOT NULL)`),
    );
    owner.store.workspaceReservations.release("storage:backup");
  }
  results(): StorageUsage["backups"] {
    return this.owner.store
      .statement(
        "SELECT b.result FROM storage_worktree_backups b JOIN managed_worktrees m ON m.path=b.path WHERE m.removed=0 ORDER BY (json_extract(b.result,'$.state')='failed') DESC,b.path LIMIT 256",
      )
      .all()
      .map((row) =>
        StorageUsage.shape.backups.unwrap().element.parse(JSON.parse(z.string().parse(row.result))),
      );
  }
  failed(path: string): boolean {
    return Boolean(
      this.owner.store
        .statement(
          "SELECT 1 FROM storage_worktree_backups WHERE path=? AND json_extract(result,'$.state')='failed'",
        )
        .get(path),
    );
  }
  async run(inventory: StorageInventory, allowed: () => boolean): Promise<void> {
    const { store, services, worktrees } = this.owner;
    const git = worktrees ?? services.workspaceActions?.git;
    if (!git) return;
    if (!allowed()) return;
    for (const record of this.batches.next(inventory.managed)) {
      if (!allowed()) return;
      if (!inventory.managed.verify(record.repo, record.path)) continue;
      const ownership = inventory.worktreeOwnership(record.path);
      if (
        ownership.protections.length ||
        !ownership.threads.length ||
        ownership.threads.some((thread) => thread.settledAt === undefined)
      )
        continue;
      const command = "storage:backup";
      let reserved = false;
      try {
        await store.writable();
        store.workspaceReservations.reserve(ThreadId.parse(command), command, [record.path]);
        reserved = true;
        // Our own reservation is deliberately present. Other reservations still refuse admission.
        const check = () => {
          if (!allowed() || !inventory.managed.verify(record.repo, record.path))
            throw new Error("backup_cancelled");
          const current = inventory.worktreeOwnership(record.path);
          if (
            current.protections.some((reason) => reason !== "cleanup_in_progress") ||
            current.threads.some((thread) => thread.settledAt === undefined)
          )
            throw new Error("backup_cancelled");
        };
        await git.backupWorktree(record.repo, record.path, check);
        this.save(record.path, "complete");
      } catch (error) {
        this.save(
          record.path,
          "failed",
          error instanceof Error && "code" in error && typeof error.code === "string"
            ? error.code
            : "backup_failed",
        );
      } finally {
        if (reserved) store.workspaceReservations.release(command);
      }
    }
  }
  private save(path: string, state: "complete" | "failed", error?: string): void {
    this.owner.store
      .statement("INSERT OR REPLACE INTO storage_worktree_backups VALUES (?,?)")
      .run(
        path,
        JSON.stringify({ path, state, updatedAt: this.owner.now(), ...(error ? { error } : {}) }),
      );
  }
}
