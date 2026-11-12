import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { sidebarFactColumns, sidebarReadable } from "./sidebar-facts.ts";

/**
 * The sidebar's facts per thread in real columns (`sidebar-facts.ts`), so its lists, totals and
 * counts are index reads instead of json_extract over every thread.
 *
 * A row holds the facts of its thread at one row revision. Triggers on
 * sidebar_thread_revisions recompute it whenever that revision changes, which every write to a
 * threads or thread_cold row does, from any connection or build (sidebar-revisions.ts), and drop
 * it with the thread, so it is written in the same transaction as the thread. At open, rows whose
 * revision isn't the thread's current one, or that a different definition of the facts made, are
 * recomputed. A thread whose JSON the facts can't be read from has `readable = 0`; while any does,
 * the sidebar evaluates the facts from threads instead, failing as it always did.
 *
 * The table is created at open, so it needs no migration step.
 */
const columns = `
  thread_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  readable INTEGER NOT NULL,
  workspace_id TEXT,
  deleted INTEGER,
  archived INTEGER,
  settled INTEGER,
  counted INTEGER,
  activity,
  archived_at INTEGER`;
// Typed as threads' own columns, so comparisons with bound values convert as they did there;
// activity is an expression there, so it has no type here.

/** One index per query the sidebar runs (`sidebar-page-storage.ts`). */
const indexes = [
  ["paged", "(activity DESC, thread_id)", "deleted = 0 AND archived = 0 AND settled = 1"],
  [
    "paged_project",
    "(workspace_id, activity DESC, thread_id)",
    "deleted = 0 AND archived = 0 AND settled = 1",
  ],
  [
    "active",
    "(workspace_id, activity DESC, thread_id)",
    "deleted = 0 AND archived = 0 AND settled = 0",
  ],
  ["archived", "(archived_at DESC, thread_id)", "deleted = 0 AND archived = 1"],
  [
    "archived_project",
    "(workspace_id, archived_at DESC, thread_id)",
    "deleted = 0 AND archived = 1",
  ],
  ["counted", "(archived, workspace_id)", "deleted = 0 AND counted = 1"],
  ["unreadable", "(thread_id)", "readable = 0"],
] as const;

/** The facts of one thread at its current revision, for the threads row matching `where`. */
function computed(where: string): string {
  const row = `SELECT threads.*, (${sidebarReadable}) AS readable FROM threads WHERE ${where}`;
  return `SELECT threads.id, revisions.revision, 1, ${sidebarFactColumns} FROM (${row}) AS threads JOIN sidebar_thread_revisions AS revisions ON revisions.thread_id = threads.id WHERE threads.readable
    UNION ALL SELECT threads.id, revisions.revision, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM (${row}) AS threads JOIN sidebar_thread_revisions AS revisions ON revisions.thread_id = threads.id WHERE NOT threads.readable`;
}

/** Fingerprints the table and the facts, so rows another definition made are recomputed. */
const shape = createHash("sha256")
  .update(`${columns}\n${sidebarReadable}\n${sidebarFactColumns}`)
  .digest("hex");

/**
 * Create the table, its indexes and triggers in `schema` ("main", or "temp" for a read-only
 * copy), and recompute every row that doesn't match its thread's current revision. Needs
 * sidebar_thread_revisions and every threads column the facts read.
 */
export function openSidebarColumns(db: DatabaseSync, schema: "main" | "temp" = "main"): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${schema}.sidebar_thread_columns (${columns});
    CREATE TABLE IF NOT EXISTS ${schema}.sidebar_columns_shape (
      id INTEGER PRIMARY KEY CHECK (id = 1), shape TEXT NOT NULL
    );
  `);
  for (const [name, on, where] of indexes)
    db.exec(
      `CREATE INDEX IF NOT EXISTS ${schema}.sidebar_columns_${name} ON sidebar_thread_columns${on} WHERE ${where}`,
    );
  const recorded = db
    .prepare(`SELECT shape FROM ${schema}.sidebar_columns_shape WHERE id = 1`)
    .get()?.shape;
  if (recorded !== shape) {
    db.exec(`DELETE FROM ${schema}.sidebar_thread_columns`);
    db.prepare(
      `INSERT INTO ${schema}.sidebar_columns_shape VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET shape = excluded.shape`,
    ).run(shape);
  }
  // Delete, then insert: the writing statement's conflict rule replaces a trigger's own (see
  // sidebar-revisions.ts). Recreated on every start, so older bodies are replaced.
  db.exec(`
    SAVEPOINT sidebar_columns_triggers;
    DROP TRIGGER IF EXISTS ${schema}.sidebar_columns_insert;
    DROP TRIGGER IF EXISTS ${schema}.sidebar_columns_delete;
    CREATE TRIGGER ${schema}.sidebar_columns_insert AFTER INSERT ON sidebar_thread_revisions BEGIN
      DELETE FROM sidebar_thread_columns WHERE thread_id = NEW.thread_id;
      INSERT INTO sidebar_thread_columns ${computed("id = NEW.thread_id")};
    END;
    CREATE TRIGGER ${schema}.sidebar_columns_delete AFTER DELETE ON sidebar_thread_revisions BEGIN
      DELETE FROM sidebar_thread_columns WHERE thread_id = OLD.thread_id;
    END;
    RELEASE sidebar_columns_triggers;
  `);
  repairSidebarColumns(db);
}

/**
 * Recompute rows not at their thread's current revision and drop rows of threads that are gone:
 * whatever changed threads without these triggers. Returns how many rows it recomputed.
 */
export function repairSidebarColumns(db: DatabaseSync): number {
  db.exec(`
    DELETE FROM sidebar_thread_columns WHERE NOT EXISTS (
      SELECT 1 FROM sidebar_thread_revisions AS revisions
      WHERE revisions.thread_id = sidebar_thread_columns.thread_id
        AND revisions.revision = sidebar_thread_columns.revision
    )
  `);
  return Number(
    db
      .prepare(
        `INSERT INTO sidebar_thread_columns ${computed("id NOT IN (SELECT thread_id FROM sidebar_thread_columns)")}`,
      )
      .run().changes,
  );
}

/** Whether every thread's facts are in sidebar_thread_columns, so the sidebar may read them there. */
export function sidebarColumnsReadable(statement: (sql: string) => StatementSync): boolean {
  return (
    statement("SELECT 1 FROM sidebar_thread_columns WHERE readable = 0 LIMIT 1").get() === undefined
  );
}
