import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Event } from "@ace/protocol";
import { z } from "zod";
import type { StoredTrust } from "./stored-decode.ts";

/**
 * Which stored rows this build may read back without validating them again (ADR 0125).
 *
 * The writer validates every event before it stores it, so a row this build wrote is already
 * in this build's shape. A row an older build wrote may not be: a newer schema can add a field
 * with a default, or rename a variant. The shape is a fingerprint of the event schema and the
 * migration version. When it differs from the one recorded, the first sequence this build
 * writes is recorded with it; rows from there on are trusted. Rows before it are decoded as
 * before until the idle pass (`stored-trust-pass.ts`) confirms them: it decodes older rows under
 * this shape and records, in `stored_event_verified`, the lowest sequence it has checked, and in
 * `stored_event_rejected` the sequences whose rows the decode would change. Going back to an
 * older build and forward again records a new start and drops what the pass confirmed, so rows
 * written or rewritten in between are never mistaken for this build's.
 */
export function storedEventShape(schemaVersion: number): string {
  const schema = z.toJSONSchema(Event, { unrepresentable: "any", io: "output", cycles: "ref" });
  return createHash("sha256")
    .update(`${schemaVersion}\n${JSON.stringify(schema)}`)
    .digest("hex");
}

const Recorded = z.object({ shape: z.string(), first_seq: z.number().int().nonnegative() });
const Verified = z.object({ shape: z.string(), from_seq: z.number().int().nonnegative() });
const Seq = z.object({ seq: z.number().int() });

function createTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS stored_event_shape (
    id INTEGER PRIMARY KEY CHECK(id = 1), shape TEXT NOT NULL, first_seq INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stored_event_verified (
    id INTEGER PRIMARY KEY CHECK(id = 1), shape TEXT NOT NULL, from_seq INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stored_event_rejected (seq INTEGER PRIMARY KEY)`);
}

/**
 * The first sequence written in `shape`. Run after migrations and before the first append.
 * Items keep the sequence they were created at, so the same boundary applies to them.
 */
export function trustedSequenceStart(db: DatabaseSync, shape: string): number {
  return sequenceStart(db, shape).start;
}
function sequenceStart(db: DatabaseSync, shape: string): { start: number; kept: boolean } {
  createTables(db);
  const recorded = Recorded.safeParse(
    db.prepare("SELECT shape, first_seq FROM stored_event_shape WHERE id = 1").get(),
  );
  if (recorded.success && recorded.data.shape === shape)
    return { start: recorded.data.first_seq, kept: true };
  const head = z
    .number()
    .int()
    .nonnegative()
    .parse(
      db
        .prepare(
          "SELECT MAX(COALESCE((SELECT seq FROM host_sequence WHERE id = 1), 0), COALESCE((SELECT MAX(seq) FROM events), 0)) AS head",
        )
        .get()?.head,
    );
  db.prepare(
    "INSERT INTO stored_event_shape VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET shape = excluded.shape, first_seq = excluded.first_seq",
  ).run(shape, head + 1);
  return { start: head + 1, kept: false };
}

/**
 * Set `trust` for `shape` at open: rows from the first sequence written in this shape on, and
 * the older rows the idle pass confirmed in this same shape, minus those it rejected. A recorded
 * pass from any other shape, or from before a new start was recorded (another build wrote in
 * between), is dropped, so a shape change
 * only means the pass runs again; it never blocks the open.
 */
export function openStoredTrust(db: DatabaseSync, shape: string, trust: StoredTrust): void {
  const { start, kept } = sequenceStart(db, shape);
  const verified = Verified.safeParse(
    db.prepare("SELECT shape, from_seq FROM stored_event_verified WHERE id = 1").get(),
  );
  trust.rejected.clear();
  if (
    kept &&
    verified.success &&
    verified.data.shape === shape &&
    verified.data.from_seq <= start
  ) {
    trust.from = verified.data.from_seq;
    for (const row of db.prepare("SELECT seq FROM stored_event_rejected").all())
      trust.rejected.add(Seq.parse(row).seq);
    return;
  }
  db.exec("DELETE FROM stored_event_rejected");
  db.prepare(
    "INSERT INTO stored_event_verified VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET shape = excluded.shape, from_seq = excluded.from_seq",
  ).run(shape, start);
  trust.from = start;
}

/**
 * Record that the pass confirmed every row from `from` on under `shape`, apart from `rejected`.
 * Run in the transaction that read the rows.
 */
export function recordStoredTrust(
  db: DatabaseSync,
  shape: string,
  from: number,
  rejected: readonly number[],
): void {
  const reject = db.prepare("INSERT OR IGNORE INTO stored_event_rejected VALUES (?)");
  for (const seq of rejected) reject.run(seq);
  db.prepare("UPDATE stored_event_verified SET from_seq = ? WHERE id = 1 AND shape = ?").run(
    from,
    shape,
  );
}
