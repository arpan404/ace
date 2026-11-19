import type { Store } from "../store.ts";
import { livePendingTable } from "./live/target-rows.ts";

/*
 * What the target's startup and retention read of its transfers, kept beside `transfer_incoming`
 * so neither ever scans it (ADR 0170):
 *
 * - `transfer_incoming_open`: transfers still receiving, cloning or importing, and settled ones
 *   whose rollback a crash cut short. Recovery reads only these.
 * - `transfer_incoming_expiry`: every other transfer, with the time retention counts from,
 *   indexed by that time. Retention reads the oldest of these.
 *
 * Both are kept in step by every write to a transfer's row. A home whose rows predate them is
 * indexed once, in pages of the primary key with a turn of the event loop between them, before
 * recovery reads them; never at open.
 */

const page = 256;

export class IncomingIndex {
  private store: Store;
  private indexing: Promise<void> | undefined;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) => {
      const fresh = !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transfer_incoming_open'")
        .get();
      db.exec("CREATE TABLE IF NOT EXISTS transfer_incoming_open (transfer_id TEXT PRIMARY KEY)");
      db.exec(`CREATE TABLE IF NOT EXISTS transfer_incoming_expiry (
        transfer_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`);
      // Made with its table, while it is empty.
      db.exec(
        "CREATE INDEX IF NOT EXISTS transfer_incoming_expiry_at ON transfer_incoming_expiry(at)",
      );
      // How far the one-time indexing of older rows got, kept with each page it writes.
      db.exec(`CREATE TABLE IF NOT EXISTS transfer_incoming_index_progress (
        id INTEGER PRIMARY KEY CHECK (id = 1), done INTEGER NOT NULL, after TEXT NOT NULL)`);
      db.exec(livePendingTable);
      // A home with no transfers yet has nothing to index.
      const empty = !db.prepare("SELECT 1 FROM transfer_incoming LIMIT 1").get();
      if (fresh && empty)
        db.exec(
          "INSERT OR IGNORE INTO transfer_incoming_index_progress (id, done, after) VALUES (1, 1, '')",
        );
    });
  }
  /** Brings one transfer's entries in step with its row; a deleted row leaves both. */
  sync(transferId: string): void {
    const row = this.store
      .statement(
        "SELECT state, registered_id, created_path, updated_at FROM transfer_incoming WHERE transfer_id=?",
      )
      .get(transferId);
    this.store.statement("DELETE FROM transfer_incoming_open WHERE transfer_id=?").run(transferId);
    this.store
      .statement("DELETE FROM transfer_incoming_expiry WHERE transfer_id=?")
      .run(transferId);
    if (!row) return;
    if (opens(row))
      this.store
        .statement("INSERT INTO transfer_incoming_open (transfer_id) VALUES (?)")
        .run(transferId);
    if (expires(row))
      this.store
        .statement("INSERT INTO transfer_incoming_expiry (transfer_id, at) VALUES (?, ?)")
        .run(transferId, Number(row["updated_at"]));
  }
  /** Indexes the rows a home had before these tables, once, in bounded pages. */
  ready(): Promise<void> {
    this.indexing ??= this.index();
    return this.indexing;
  }
  private async index(): Promise<void> {
    const progress = this.store
      .statement("SELECT done, after FROM transfer_incoming_index_progress WHERE id=1")
      .get();
    if (progress?.["done"] === 1) return;
    // Carries on from the last page a restart cut short, never from the start again.
    let after = progress ? String(progress["after"]) : "";
    for (;;) {
      const ids = this.store
        .statement(
          `SELECT transfer_id FROM transfer_incoming WHERE transfer_id>? ORDER BY transfer_id LIMIT ${page}`,
        )
        .all(after)
        .map((row) => String(row["transfer_id"]));
      const last = ids.at(-1);
      const done = !last || ids.length < page;
      this.store.atomic(() => {
        for (const id of ids) this.sync(id);
        this.store
          .statement(
            `INSERT INTO transfer_incoming_index_progress (id, done, after) VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET done=excluded.done, after=excluded.after`,
          )
          .run(done ? 1 : 0, last ?? after);
      });
      if (done || !last) break;
      after = last;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

const unsettled = new Set(["receiving", "cloning", "importing"]);
const expiring = new Set(["receiving", "completed", "failed", "cancelled"]);

/** Still receiving, cloning or importing, or settled with a rollback left to finish. */
function opens(row: Record<string, unknown>): boolean {
  const state = String(row["state"]);
  if (unsettled.has(state)) return true;
  return (
    (state === "failed" || state === "cancelled") &&
    (row["registered_id"] !== null || row["created_path"] !== null)
  );
}

/** Retention counts from its last change: receiving (an upload that stopped) or settled. */
function expires(row: Record<string, unknown>): boolean {
  return expiring.has(String(row["state"]));
}
