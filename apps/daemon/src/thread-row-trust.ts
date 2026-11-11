import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
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
 * as stored; rows anything else changed are confirmed again at a later open.
 *
 * Stamps hold only for the decoder that made them: the shape fingerprints the thread schemas,
 * the migration version and the decoders' own code, and a different shape clears every stamp.
 * Both tables are created at open, so they need no migration step.
 */
export function threadRowShape(schemaVersion: number): string {
  const schemas = [Thread, ThreadClientFields, ThreadTransitionView, ThreadProviderMetadata].map(
    (schema) => z.toJSONSchema(schema, { unrepresentable: "any", io: "output", cycles: "ref" }),
  );
  return createHash("sha256")
    .update(`${schemaVersion}\n${JSON.stringify(schemas)}\n${threadRowDecoderSource()}`)
    .digest("hex");
}

/** Create the stamp tables and drop every stamp a different shape made. Before any thread read. */
export function openThreadRowTrust(db: DatabaseSync, shape: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_row_shape (
      id INTEGER PRIMARY KEY CHECK (id = 1), shape TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS thread_row_trust (
      thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, canonical INTEGER NOT NULL
    );
  `);
  const recorded = db.prepare("SELECT shape FROM thread_row_shape WHERE id = 1").get()?.shape;
  if (recorded === shape) return;
  db.exec("DELETE FROM thread_row_trust");
  db.prepare(
    "INSERT INTO thread_row_shape VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET shape = excluded.shape",
  ).run(shape);
}

/** Rows confirmed per open: about 35 ms of CPU on a loaded laptop, so an upgrade never stalls a start. */
export const confirmedPerOpen = 256;

/**
 * Confirm rows not yet checked at their current revision, the most recently updated first and
 * at most `limit` of them: after an upgrade all rows need it, a few opens' worth; otherwise
 * only rows something other than this build's writer changed. Rows left for a later open are
 * validated on read, as before. A row that doesn't read the same as stored is recorded as
 * checked, so it is validated on read and not checked again until it changes. Run after the
 * open-time passes that rewrite threads rows. Returns how many rows it checked.
 */
export function confirmThreadRows(db: DatabaseSync, limit = confirmedPerOpen): number {
  db.exec("DELETE FROM thread_row_trust WHERE thread_id NOT IN (SELECT id FROM threads)");
  const rows = db
    .prepare(
      `SELECT ${threadRowColumns}, revisions.revision AS row_revision FROM ${threadRowSource} JOIN sidebar_thread_revisions AS revisions ON revisions.thread_id = threads.id WHERE NOT EXISTS (SELECT 1 FROM thread_row_trust AS trust WHERE trust.thread_id = threads.id AND trust.revision = revisions.revision) ORDER BY threads.updated_at DESC, threads.id LIMIT ?`,
    )
    .all(limit);
  const stamp = db.prepare(
    "INSERT INTO thread_row_trust VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET revision = excluded.revision, canonical = excluded.canonical",
  );
  for (const row of rows)
    stamp.run(String(row.id), Number(row.row_revision), confirmThreadRow(row).canonical ? 1 : 0);
  return rows.length;
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
