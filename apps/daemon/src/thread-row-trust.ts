import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue, StatementSync } from "node:sqlite";
import {
  Thread,
  ThreadClientFields,
  ThreadProviderMetadata,
  ThreadTransitionView,
} from "@ace/protocol";
import { z } from "zod";
import {
  confirmThreadRow,
  threadRowColumns,
  threadRowDecoderSource,
  threadRowSource,
} from "./thread-row.ts";

/**
 * Which threads rows this build may read back without validating them again (ADR 0125).
 *
 * A threads row is rewritten in place, a few columns at a time, and has no sequence, so the
 * event boundary can't say who wrote it. Instead `thread_row_trust` records, per thread, a row
 * revision at which this build confirmed the whole row reads the same as stored as validated,
 * field order included. Every write to a threads or thread_cold row, by any build or by direct
 * SQL, takes a new and never reused revision (sidebar-revisions.ts, thread-cold.ts), so a
 * stamp names exactly the content that was confirmed. This build's writer moves a stamp to the
 * revision it writes when the row was confirmed before and every part it wrote reads the same
 * as stored. Rows anything else changed are confirmed again by the idle pass, which walks row
 * revisions from its saved position (ADR 0170); until then they are validated on read.
 *
 * Stamps hold only for the decoder that made them: the shape fingerprints the thread schemas,
 * the migration version and the decoders' own code, and a different shape clears every stamp.
 * The tables are created at open, so they need no migration step.
 */
export function threadRowShape(schemaVersion: number): string {
  const schemas = [Thread, ThreadClientFields, ThreadTransitionView, ThreadProviderMetadata].map(
    (schema) => z.toJSONSchema(schema, { unrepresentable: "any", io: "output", cycles: "ref" }),
  );
  return createHash("sha256")
    .update(`${schemaVersion}\n${JSON.stringify(schemas)}\n${threadRowDecoderSource()}`)
    .digest("hex");
}

/**
 * Create the stamp tables and drop every stamp a different shape made. Before any thread read.
 * Constant work, apart from clearing the stamps once after a shape change.
 */
export function openThreadRowTrust(db: DatabaseSync, shape: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_row_shape (
      id INTEGER PRIMARY KEY CHECK (id = 1), shape TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS thread_row_trust (
      thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, canonical INTEGER NOT NULL
    );
    -- How far the idle pass got: every row whose revision is at most revision was checked
    -- at that revision. orphans_after is where the sweep for stamps of deleted threads,
    -- left by builds before the triggers below, resumes; NULL once it has finished.
    CREATE TABLE IF NOT EXISTS thread_row_trust_progress (
      id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, orphans_after TEXT
    );
    INSERT OR IGNORE INTO thread_row_trust_progress VALUES (1, 0, '');
    -- A stamp never outlives its thread. A stale one would never match (revisions are not
    -- reused); this only keeps the table from growing.
    CREATE TRIGGER IF NOT EXISTS thread_row_trust_owner_delete AFTER DELETE ON threads BEGIN
      DELETE FROM thread_row_trust WHERE thread_id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS thread_row_trust_owner_rekey AFTER UPDATE OF id ON threads
    WHEN OLD.id IS NOT NEW.id BEGIN
      DELETE FROM thread_row_trust WHERE thread_id = OLD.id;
    END;
  `);
  const recorded = db.prepare("SELECT shape FROM thread_row_shape WHERE id = 1").get()?.shape;
  if (recorded === shape) return;
  db.exec("DELETE FROM thread_row_trust");
  // No stamps are left, so every row needs checking again and no orphan can remain.
  db.exec("UPDATE thread_row_trust_progress SET revision = 0, orphans_after = NULL WHERE id = 1");
  db.prepare(
    "INSERT INTO thread_row_shape VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET shape = excluded.shape",
  ).run(shape);
}

/**
 * Rows confirmed at open: only the most recently changed ones, so a thread an agent keeps
 * writing is read as stored from the start even while the idle pass waits for runs to end.
 * About 9 ms of CPU after an upgrade and nothing after, however many threads there are.
 */
export const confirmedPerOpen = 64;

const unstamped =
  "NOT EXISTS (SELECT 1 FROM thread_row_trust AS trust WHERE trust.thread_id = threads.id AND trust.revision = revisions.revision)";

/** Check and stamp each row; a row that doesn't read the same as stored is stamped as checked. */
function stampRows(db: DatabaseSync, rows: Record<string, SQLOutputValue>[]): number {
  const stamp = db.prepare(
    "INSERT INTO thread_row_trust VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET revision = excluded.revision, canonical = excluded.canonical",
  );
  for (const row of rows)
    stamp.run(String(row.id), Number(row.row_revision), confirmThreadRow(row).canonical ? 1 : 0);
  return rows.length;
}

/**
 * Confirm the `limit` most recently changed rows not yet checked at their current revision.
 * Reads at most `limit` revisions, newest first by their key, so it never grows with history.
 * Rows left over are validated on read until the idle pass reaches them. Run after the
 * open-time passes that rewrite threads rows. Returns how many rows it checked.
 */
export function confirmRecentThreadRows(db: DatabaseSync, limit = confirmedPerOpen): number {
  return stampRows(
    db,
    db
      .prepare(
        `SELECT ${threadRowColumns}, revisions.revision AS row_revision FROM ${threadRowSource} JOIN (SELECT revision, thread_id FROM sidebar_thread_revisions ORDER BY revision DESC LIMIT ?) AS revisions ON revisions.thread_id = threads.id WHERE ${unstamped}`,
      )
      .all(limit),
  );
}

/** What one step of the idle walk did. */
export interface ThreadRowStep {
  /** Rows it checked and stamped. */
  checked: number;
  /** Whether anything may be left for a later step. */
  more: boolean;
}

/**
 * One bounded step of the idle pass (`stored-trust-pass.ts`): read the next `scan` row
 * revisions after the saved position, oldest first, check and stamp at most `limit` of their
 * rows not yet checked at that revision, and save how far it got. Every write to a row takes
 * a new, higher revision, so a row anything other than this build's writer changed since is
 * found again, and a restart resumes where the last one stopped. Once caught up, deletes
 * stamps of threads that no longer exist, reading `scan` stamps a step.
 */
export function confirmThreadRows(
  db: DatabaseSync,
  limit: number,
  scan = limit * 16,
): ThreadRowStep {
  const progress = db
    .prepare("SELECT revision, orphans_after FROM thread_row_trust_progress WHERE id = 1")
    .get();
  if (!progress) return { checked: 0, more: false };
  const after = Number(progress.revision);
  const orphansAfter = progress.orphans_after;
  const page = db
    .prepare(
      "SELECT COUNT(*) AS n, MAX(revision) AS last FROM (SELECT revision FROM sidebar_thread_revisions WHERE revision > ? ORDER BY revision LIMIT ?)",
    )
    .get(after, scan);
  const read = Number(page?.n ?? 0);
  if (read > 0) {
    const rows = db
      .prepare(
        `SELECT ${threadRowColumns}, revisions.revision AS row_revision FROM ${threadRowSource} JOIN sidebar_thread_revisions AS revisions ON revisions.thread_id = threads.id WHERE revisions.revision > ? AND revisions.revision <= ? AND ${unstamped} ORDER BY revisions.revision LIMIT ?`,
      )
      .all(after, Number(page?.last), limit);
    stampRows(db, rows);
    const full = rows.length === limit;
    const reached = full ? Number(rows.at(-1)?.row_revision) : Number(page?.last);
    db.prepare("UPDATE thread_row_trust_progress SET revision = ? WHERE id = 1").run(reached);
    return {
      checked: rows.length,
      more: full || read === scan || typeof orphansAfter === "string",
    };
  }
  if (typeof orphansAfter !== "string") return { checked: 0, more: false };
  const keys = db
    .prepare(
      "SELECT COUNT(*) AS n, MAX(thread_id) AS end FROM (SELECT thread_id FROM thread_row_trust WHERE thread_id > ? ORDER BY thread_id LIMIT ?)",
    )
    .get(orphansAfter, scan);
  const end = keys?.end;
  if (typeof end === "string")
    db.prepare(
      "DELETE FROM thread_row_trust WHERE thread_id > ? AND thread_id <= ? AND NOT EXISTS (SELECT 1 FROM threads WHERE threads.id = thread_row_trust.thread_id)",
    ).run(orphansAfter, end);
  const more = Number(keys?.n ?? 0) === scan;
  db.prepare("UPDATE thread_row_trust_progress SET orphans_after = ? WHERE id = 1").run(
    more ? String(end) : null,
  );
  return { checked: 0, more };
}

/** Whether this thread's row, as it is now, is confirmed. Read before the writer changes it. */
export function threadRowConfirmed(statement: (sql: string) => StatementSync, id: string): boolean {
  return (
    statement(
      "SELECT 1 FROM thread_row_trust AS trust JOIN sidebar_thread_revisions AS current ON current.thread_id = trust.thread_id AND current.revision = trust.revision WHERE trust.thread_id = ? AND trust.canonical = 1",
    ).get(id) !== undefined
  );
}

/** The writer left the confirmed row `id` at `revision`, still reading the same as stored. */
export function keepThreadRowConfirmed(
  statement: (sql: string) => StatementSync,
  id: string,
  revision: number,
): void {
  statement(
    "INSERT INTO thread_row_trust VALUES (?, ?, 1) ON CONFLICT(thread_id) DO UPDATE SET revision = excluded.revision, canonical = 1",
  ).run(id, revision);
}
