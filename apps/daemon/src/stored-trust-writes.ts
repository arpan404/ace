import type { DatabaseSync } from "node:sqlite";
import { recordStoredTrust, type OpenedTrust } from "./stored-shape.ts";
import { confirmThreadRows } from "./thread-row-trust.ts";

/**
 * The writes the idle trust pass makes (`stored-trust-pass.ts`, ADR 0125). Each is a named
 * operation whose SQL is fixed in `stored-shape.ts` or `thread-row-trust.ts` and writes only the
 * trust tables: which stored rows are read as stored, never what any read returns. So each
 * commits outside the store's transaction hooks, and its rows are counted as accounted for and
 * belonging to no thread, so the thread read cache keeps its entries and views across it. No caller gets a connection under that carry-over; a new trust write is a new
 * method here.
 */
export interface TrustTableWrites {
  /**
   * Save the pass's progress: rows from `from` on are confirmed, apart from `rejected`, for
   * what open recorded. False when another build recorded a start since; nothing is saved.
   */
  saveProgress(
    shape: string,
    opened: OpenedTrust,
    from: number,
    rejected: readonly number[],
  ): boolean;
  /**
   * Confirm up to `limit` thread rows not yet confirmed at their current revision, and stamp
   * them (`thread-row-trust.ts`). A stamp only picks whether a row is decoded with validation
   * or without, which read the same. Returns how many rows it checked.
   */
  stampThreadRows(limit: number): number;
}

export interface TrustTableWritesOptions {
  db: DatabaseSync;
  /**
   * Count `rows` changes on the connection as accounted for and attributed to no thread: the
   * thread read cache neither drops entries nor marks views stale for them (`store.ts`).
   */
  accounted(rows: number): void;
}

export function trustTableWrites(options: TrustTableWritesOptions): TrustTableWrites {
  const { db } = options;
  const changes = () => Number(db.prepare("SELECT total_changes() AS n").get()?.n);
  /**
   * One fixed trust write in its own transaction, never inside or across another. Every change
   * it makes is accounted for, including those of a write that then rolls back: the connection's
   * change count still moved, and the cache must not take that for a write it can't see.
   */
  const neutral = <T>(write: () => T): T => {
    if (db.isTransaction) throw new Error("A trust write runs outside any transaction");
    const before = changes();
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = write();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      options.accounted(changes() - before);
    }
  };
  return {
    saveProgress: (shape, opened, from, rejected) =>
      neutral(() => recordStoredTrust(db, shape, opened, from, rejected)),
    stampThreadRows: (limit) => neutral(() => confirmThreadRows(db, limit)),
  };
}
