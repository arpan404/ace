import type { Store } from "../store.ts";

/*
 * What startup and retention read of a transfers table, kept beside it so neither ever scans it
 * (ADR 0170). `<table>_open` lists the transfers recovery still has work for; `<table>_expiry`
 * every other one, with the time retention counts from, indexed by that time. Both are kept in
 * step by every write to a transfer's row. A home whose rows predate them is indexed once, in
 * pages of the primary key with a turn of the event loop between them, its progress kept with
 * each page, before recovery reads them; never at open.
 */

const page = 256;

export interface TransferIndexShape {
  /** The transfers table, keyed by `transfer_id`. */
  table: string;
  /** Columns `opens` and `expiresAt` read. */
  columns: string;
  /** Recovery still has work for it. */
  opens(row: Record<string, unknown>): boolean;
  /** When retention counts from, or none while it may not expire. */
  expiresAt(row: Record<string, unknown>): number | undefined;
}

export class TransferIndex {
  private store: Store;
  private shape: TransferIndexShape;
  private indexing: Promise<void> | undefined;
  readonly open: string;
  readonly expiry: string;
  private progress: string;
  constructor(store: Store, shape: TransferIndexShape) {
    this.store = store;
    this.shape = shape;
    this.open = `${shape.table}_open`;
    this.expiry = `${shape.table}_expiry`;
    this.progress = `${shape.table}_index_progress`;
    store.atomic((db) => {
      const fresh = !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(this.open);
      db.exec(`CREATE TABLE IF NOT EXISTS ${this.open} (transfer_id TEXT PRIMARY KEY)`);
      db.exec(`CREATE TABLE IF NOT EXISTS ${this.expiry} (
        transfer_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`);
      // Made with its table, while it is empty.
      db.exec(`CREATE INDEX IF NOT EXISTS ${this.expiry}_at ON ${this.expiry}(at)`);
      db.exec(`CREATE TABLE IF NOT EXISTS ${this.progress} (
        id INTEGER PRIMARY KEY CHECK (id = 1), done INTEGER NOT NULL, after TEXT NOT NULL)`);
      // A home with no transfers yet has nothing to index.
      const empty = !db.prepare(`SELECT 1 FROM ${shape.table} LIMIT 1`).get();
      if (fresh && empty)
        db.exec(`INSERT OR IGNORE INTO ${this.progress} (id, done, after) VALUES (1, 1, '')`);
    });
  }
  /** Brings one transfer's entries in step with its row; a deleted row leaves both. */
  sync(transferId: string): void {
    const row = this.store
      .statement(`SELECT ${this.shape.columns} FROM ${this.shape.table} WHERE transfer_id=?`)
      .get(transferId);
    this.store.statement(`DELETE FROM ${this.open} WHERE transfer_id=?`).run(transferId);
    this.store.statement(`DELETE FROM ${this.expiry} WHERE transfer_id=?`).run(transferId);
    if (!row) return;
    if (this.shape.opens(row))
      this.store.statement(`INSERT INTO ${this.open} (transfer_id) VALUES (?)`).run(transferId);
    const at = this.shape.expiresAt(row);
    if (at !== undefined)
      this.store
        .statement(`INSERT INTO ${this.expiry} (transfer_id, at) VALUES (?, ?)`)
        .run(transferId, at);
  }
  /** Indexes the rows a home had before these tables, once, in bounded pages. */
  ready(): Promise<void> {
    this.indexing ??= this.index();
    return this.indexing;
  }
  private async index(): Promise<void> {
    const progress = this.store
      .statement(`SELECT done, after FROM ${this.progress} WHERE id=1`)
      .get();
    if (progress?.["done"] === 1) return;
    // Carries on from the last page a restart cut short, never from the start again.
    let after = progress ? String(progress["after"]) : "";
    for (;;) {
      const ids = this.store
        .statement(
          `SELECT transfer_id FROM ${this.shape.table} WHERE transfer_id>? ORDER BY transfer_id LIMIT ${page}`,
        )
        .all(after)
        .map((row) => String(row["transfer_id"]));
      const last = ids.at(-1);
      const done = !last || ids.length < page;
      this.store.atomic(() => {
        for (const id of ids) this.sync(id);
        this.store
          .statement(
            `INSERT INTO ${this.progress} (id, done, after) VALUES (1, ?, ?)
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
