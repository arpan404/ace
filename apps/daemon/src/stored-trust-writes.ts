import type { DatabaseSync } from "node:sqlite";
import { recordStoredTrust, type OpenedTrust } from "./stored-shape.ts";
import { confirmThreadRows } from "./thread-row-trust.ts";

/**
 * The writes the idle trust pass makes (`stored-trust-pass.ts`, ADR 0125). Each is a named
 * operation whose SQL is fixed in `stored-shape.ts` or `thread-row-trust.ts` and writes only the
 * trust tables: which stored rows are read as stored, never what any read returns. So each
 * commits outside the store's transaction hooks and the thread read cache keeps its entries
 * across it. No caller gets a connection under that carry-over; a new trust write is a new
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
  /** The generation the thread read cache is keyed by: other connections' and own commits. */
  generation(): string;
  /** Keep entries cached at `before` usable at `after`. */
  carryOver(before: string, after: string): void;
}

export function trustTableWrites(options: TrustTableWritesOptions): TrustTableWrites {
  const { db } = options;
  /** One fixed trust write in its own transaction, outside any other. */
  const neutral = <T>(write: () => T): T => {
    const before = options.generation();
    db.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = write();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const after = options.generation();
    // Another connection committed meanwhile: its change may matter, so the cache drops as usual.
    if (before.split(":")[0] === after.split(":")[0]) options.carryOver(before, after);
    return result;
  };
  return {
    saveProgress: (shape, opened, from, rejected) =>
      neutral(() => recordStoredTrust(db, shape, opened, from, rejected)),
    stampThreadRows: (limit) => neutral(() => confirmThreadRows(db, limit)),
  };
}
