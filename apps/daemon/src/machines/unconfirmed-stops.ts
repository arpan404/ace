import type { Store } from "../store.ts";

/*
 * Children on other machines whose stop their machine never confirmed (ADR 0191): settled with
 * `stopped_unconfirmed` 1 or 3, or lost. A live move reads them on every look while it stops a
 * tree, so they live in a table of their own that holds only them: the read is proportional to
 * the unconfirmed children, never to a parent's history of confirmed ones (ADR 0170).
 *
 * The table and the triggers that keep it current are made, empty, on first use; nothing is
 * built over machine_children at open. Rows that were already unconfirmed before are found per
 * parent in bounded batches, resumed across looks and restarts; until a parent's are all found
 * its read says so (`complete: false`), and the move keeps waiting rather than take it as clear.
 */

/** Settled rows of one parent read per look while finding the ones from before the table. */
export const scanBatch = 2_000;

const unconfirmed =
  "NEW.settled=1 AND (NEW.stopped_unconfirmed IN (1,3) OR NEW.lost_at IS NOT NULL)";

const schema = `
  CREATE TABLE IF NOT EXISTS machine_children_unconfirmed (
    id TEXT PRIMARY KEY, parent_thread TEXT NOT NULL, role TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS machine_children_unconfirmed_parent
    ON machine_children_unconfirmed(parent_thread);
  CREATE TABLE IF NOT EXISTS machine_children_unconfirmed_scan (
    parent_thread TEXT PRIMARY KEY, after INTEGER NOT NULL, done INTEGER NOT NULL);
  CREATE TRIGGER IF NOT EXISTS machine_children_unconfirmed_insert
    AFTER INSERT ON machine_children BEGIN
      INSERT OR REPLACE INTO machine_children_unconfirmed (id, parent_thread, role)
        SELECT NEW.id, NEW.parent_thread, NEW.role WHERE ${unconfirmed};
    END;
  CREATE TRIGGER IF NOT EXISTS machine_children_unconfirmed_update
    AFTER UPDATE ON machine_children BEGIN
      DELETE FROM machine_children_unconfirmed WHERE id=OLD.id;
      INSERT OR REPLACE INTO machine_children_unconfirmed (id, parent_thread, role)
        SELECT NEW.id, NEW.parent_thread, NEW.role WHERE ${unconfirmed};
    END;
  CREATE TRIGGER IF NOT EXISTS machine_children_unconfirmed_delete
    AFTER DELETE ON machine_children BEGIN
      DELETE FROM machine_children_unconfirmed WHERE id=OLD.id;
    END;`;

export class UnconfirmedStops {
  private store: Store;
  private ready = false;
  constructor(store: Store) {
    this.store = store;
  }
  /**
   * The roles of `parents`' unconfirmed children, at most `limit`, and whether every parent's
   * older rows have been looked through (`complete`). Each call looks through at most one batch
   * of each parent not yet done.
   */
  read(parents: readonly string[], limit: number): { roles: string[]; complete: boolean } {
    return this.store.atomic((db) => {
      if (!this.ready) {
        // New, empty tables and triggers: nothing here reads machine_children.
        db.exec(schema);
        this.ready = true;
      }
      let complete = true;
      for (const parent of parents) if (!this.scan(parent)) complete = false;
      const roles: string[] = [];
      for (let at = 0; at < parents.length && roles.length < limit; at += 256) {
        const chunk = parents.slice(at, at + 256);
        roles.push(
          ...this.store
            .statement(
              `SELECT role FROM machine_children_unconfirmed
                WHERE parent_thread IN (${chunk.map(() => "?").join(",")}) LIMIT ${limit - roles.length}`,
            )
            .all(...chunk)
            .map((row) => String(row["role"]).slice(0, 256)),
        );
      }
      return { roles, complete };
    });
  }
  /**
   * One batch of `parent`'s settled rows from before the triggers, in rowid order through
   * machine_children_parent (parent_thread, settled), resumed where the last one stopped. Rowids
   * hold: ace never runs a full VACUUM (`storage/apply.ts`). True once all are looked through.
   */
  private scan(parent: string): boolean {
    const progress = this.store
      .statement("SELECT after, done FROM machine_children_unconfirmed_scan WHERE parent_thread=?")
      .get(parent);
    if (progress?.["done"] === 1) return true;
    const after = Number(progress?.["after"] ?? 0);
    const rows = this.store
      .statement(
        `SELECT rowid AS at, id, role, stopped_unconfirmed, lost_at FROM machine_children
          WHERE parent_thread=? AND settled=1 AND rowid>? ORDER BY rowid LIMIT ${scanBatch}`,
      )
      .all(parent, after);
    const add = this.store.statement(
      "INSERT OR IGNORE INTO machine_children_unconfirmed (id, parent_thread, role) VALUES (?,?,?)",
    );
    for (const row of rows)
      if (
        row["stopped_unconfirmed"] === 1 ||
        row["stopped_unconfirmed"] === 3 ||
        row["lost_at"] !== null
      )
        add.run(String(row["id"]), parent, String(row["role"]));
    const done = rows.length < scanBatch;
    const last = rows.length ? Number(rows[rows.length - 1]?.["at"]) : after;
    this.store
      .statement(
        `INSERT INTO machine_children_unconfirmed_scan (parent_thread, after, done) VALUES (?,?,?)
          ON CONFLICT(parent_thread) DO UPDATE SET after=excluded.after, done=excluded.done`,
      )
      .run(parent, last, done ? 1 : 0);
    return done;
  }
}
