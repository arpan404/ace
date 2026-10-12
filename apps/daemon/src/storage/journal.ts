import { StorageCompactionMode, StoragePlan, type StorageApply } from "@ace/protocol";
import { z } from "zod";
import type { Store } from "../store.ts";
import { ReviewedStorageItem } from "./types.ts";

export const CleanupJournal = z.object({
  plan: StoragePlan,
  entries: z.array(ReviewedStorageItem).max(256),
  owner: z.string(),
  state: z.enum(["review", "applying", "complete", "stale"]),
});
export type CleanupJournal = z.infer<typeof CleanupJournal>;
export const CompactionJournal = z.object({
  id: z.string(),
  owner: z.string(),
  mode: StorageCompactionMode,
  state: z.enum(["running", "interrupted", "complete", "abandoned"]),
  phase: z.enum(["vacuum", "checkpoint"]),
  chunks: z.number().int().nonnegative(),
  databaseBytesBefore: z.number().int().nonnegative(),
  fullRequired: z.boolean(),
  checkpointed: z.boolean(),
});
export type CompactionJournal = z.infer<typeof CompactionJournal>;

export class StorageJournal {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS storage_plans(id TEXT PRIMARY KEY, owner TEXT NOT NULL,
        state TEXT NOT NULL, expires INTEGER NOT NULL, document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS storage_plan_recovery ON storage_plans(state,id);
      CREATE TABLE IF NOT EXISTS storage_purged(thread_id TEXT PRIMARY KEY,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS storage_compactions(id TEXT PRIMARY KEY, state TEXT NOT NULL,
        document TEXT NOT NULL);
    `),
    );
  }
  get(id: string): CleanupJournal | undefined {
    const row = this.store.statement("SELECT document FROM storage_plans WHERE id=?").get(id);
    return row ? CleanupJournal.parse(JSON.parse(z.string().parse(row.document))) : undefined;
  }
  save(journal: CleanupJournal): void {
    CleanupJournal.parse(journal);
    this.store
      .statement(`INSERT INTO storage_plans VALUES(?,?,?,?,?) ON CONFLICT(id)
      DO UPDATE SET state=excluded.state,document=excluded.document`)
      .run(
        journal.plan.id,
        journal.owner,
        journal.state,
        journal.plan.expiresAt,
        JSON.stringify(journal),
      );
  }
  admit(journal: CleanupJournal, now: number): void {
    this.store.atomic(() => {
      this.store
        .statement(
          "DELETE FROM storage_plans WHERE state IN ('review','complete','stale') AND expires<?",
        )
        .run(now - 30 * 86400000);
      const count = Number(
        this.store.statement("SELECT COUNT(*) AS n FROM storage_plans").get()?.n,
      );
      if (count >= 64) throw new Error("storage_plan_capacity");
      this.save(journal);
    });
  }
  /** At most one compaction is unfinished; settled ones keep only the latest few. */
  unfinishedCompaction(): CompactionJournal | undefined {
    const row = this.store
      .statement(
        "SELECT document FROM storage_compactions WHERE state IN ('running','interrupted') LIMIT 1",
      )
      .get();
    return row ? CompactionJournal.parse(JSON.parse(z.string().parse(row.document))) : undefined;
  }
  compaction(id: string): CompactionJournal | undefined {
    const row = this.store.statement("SELECT document FROM storage_compactions WHERE id=?").get(id);
    return row ? CompactionJournal.parse(JSON.parse(z.string().parse(row.document))) : undefined;
  }
  saveCompaction(journal: CompactionJournal): void {
    CompactionJournal.parse(journal);
    this.store.atomic(() => {
      this.store
        .statement(`INSERT INTO storage_compactions VALUES(?,?,?) ON CONFLICT(id)
        DO UPDATE SET state=excluded.state,document=excluded.document`)
        .run(journal.id, journal.state, JSON.stringify(journal));
      this.store
        .statement(
          "DELETE FROM storage_compactions WHERE state IN ('complete','abandoned') AND id NOT IN (SELECT id FROM storage_compactions WHERE state IN ('complete','abandoned') ORDER BY rowid DESC LIMIT 8)",
        )
        .run();
    });
  }
  pending(): string[] {
    return this.store
      .statement("SELECT id FROM storage_plans WHERE state='applying' ORDER BY id LIMIT 64")
      .all()
      .map((row) => z.string().parse(row.id));
  }
  result(journal: CleanupJournal): StorageApply {
    return {
      planId: journal.plan.id,
      state:
        journal.state === "stale" ? "stale" : journal.state === "complete" ? "complete" : "pending",
      items: journal.entries
        .filter((entry) => entry.item.disposition === "remove")
        .map((entry) => ({
          id: entry.item.id,
          state: entry.state === "running" ? "pending" : entry.state,
          reason: entry.reason,
          error: entry.error,
        })),
    };
  }
}
