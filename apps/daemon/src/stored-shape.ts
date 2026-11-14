import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
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
 * before until the idle pass (`stored-trust-pass.ts`) confirms them.
 *
 * What the pass confirmed belongs to one build and one write generation.
 * - The build (`storedTrustBuild`) is the release version together with the bundled code it
 *   runs: the shape can't see a changed transform or decoder, so every new build checks again.
 *   A daemon run from source never keeps what it confirmed.
 * - The generation is a counter that triggers in the database bump on every write to
 *   `stored_event_shape`, by any build, including builds from before the pass, so a build that
 *   recorded its own start in between invalidates the record.
 * `stored_event_confirmed` holds the build, the generation and the lowest sequence confirmed;
 * `stored_event_rejected` the sequences whose rows the decode would change.
 */
export function storedEventShape(schemaVersion: number): string {
  const schema = z.toJSONSchema(Event, { unrepresentable: "any", io: "output", cycles: "ref" });
  return createHash("sha256")
    .update(`${schemaVersion}\n${JSON.stringify(schema)}`)
    .digest("hex");
}

/**
 * The build key what the pass confirmed is kept under: the release version (`ACE_VERSION`) and
 * the bytes of the bundled daemon entry it runs from (`runningBundle`). The release bundles the
 * daemon as `ace.mjs` with content-hashed chunks whose names the entry holds, so any change to
 * the shipped code, a protocol transform included, changes the key, while a rebuild of the same
 * code keeps it. Undefined for a daemon run from source, so nothing it confirms outlives it.
 */
export function storedTrustBuild(
  version: string | undefined,
  bundle: Uint8Array | undefined,
): string | undefined {
  if (!version || version === "development" || !bundle) return undefined;
  return createHash("sha256").update(`${version}\n`).update(bundle).digest("hex");
}

/** The bundled daemon entry this process runs from (`ace.mjs`), or undefined from source. */
export function runningBundle(entry: string | undefined): Uint8Array | undefined {
  if (!entry || basename(entry) !== "ace.mjs") return undefined;
  try {
    return readFileSync(entry);
  } catch {
    return undefined;
  }
}

const Recorded = z.object({ shape: z.string(), first_seq: z.number().int().nonnegative() });

function createTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS stored_event_shape (
    id INTEGER PRIMARY KEY CHECK(id = 1), shape TEXT NOT NULL, first_seq INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stored_event_generation (
    id INTEGER PRIMARY KEY CHECK(id = 1), generation INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO stored_event_generation VALUES (1, 0);
  CREATE TRIGGER IF NOT EXISTS stored_event_shape_inserted AFTER INSERT ON stored_event_shape
    BEGIN UPDATE stored_event_generation SET generation = generation + 1 WHERE id = 1; END;
  CREATE TRIGGER IF NOT EXISTS stored_event_shape_updated AFTER UPDATE ON stored_event_shape
    BEGIN UPDATE stored_event_generation SET generation = generation + 1 WHERE id = 1; END;
  CREATE TRIGGER IF NOT EXISTS stored_event_shape_deleted AFTER DELETE ON stored_event_shape
    BEGIN UPDATE stored_event_generation SET generation = generation + 1 WHERE id = 1; END;
  CREATE TABLE IF NOT EXISTS stored_event_confirmed (
    id INTEGER PRIMARY KEY CHECK(id = 1), build TEXT NOT NULL, shape TEXT NOT NULL,
    generation INTEGER NOT NULL, from_seq INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stored_event_rejected (seq INTEGER PRIMARY KEY)`);
}

/** The current write generation; see the module comment. */
export function storedWriteGeneration(db: DatabaseSync): number {
  // Trusted: the counter only this module's triggers and table write.
  return Number(
    db.prepare("SELECT generation FROM stored_event_generation WHERE id = 1").get()?.generation,
  );
}

/**
 * Record `shape`'s start when it differs from the recorded one: the first sequence written in
 * it. Items keep the sequence they were created at, so the same boundary applies to them.
 */
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

/** Where `trust` stands after open, and what the pass must match to extend it. */
export interface OpenedTrust {
  generation: number;
  /** Undefined when what the pass confirms is kept in memory only. */
  build: string | undefined;
}

/**
 * Set `trust` for `shape` at open. Run after migrations and every open-time pass that rewrites
 * stored rows, and before the first append. Trusted: rows from the first sequence written in
 * this shape on, and the older rows the idle pass confirmed in this build and generation, minus
 * those it rejected. Anything else recorded is dropped, so a change only means the pass runs
 * again; it never blocks the open. The start, the reset and the rejections change in one
 * savepoint, so an interrupted open leaves the previous state whole.
 */
export function openStoredTrust(
  db: DatabaseSync,
  shape: string,
  build: string | undefined,
  trust: StoredTrust,
): OpenedTrust {
  trust.from = Number.POSITIVE_INFINITY;
  trust.rejected.clear();
  db.exec("SAVEPOINT stored_trust_open");
  try {
    const opened = openInSavepoint(db, shape, build, trust);
    db.exec("RELEASE stored_trust_open");
    return opened;
  } catch (error) {
    db.exec("ROLLBACK TO stored_trust_open; RELEASE stored_trust_open");
    trust.from = Number.POSITIVE_INFINITY;
    trust.rejected.clear();
    throw error;
  }
}
function openInSavepoint(
  db: DatabaseSync,
  shape: string,
  build: string | undefined,
  trust: StoredTrust,
): OpenedTrust {
  const { start, kept } = sequenceStart(db, shape);
  const generation = storedWriteGeneration(db);
  const record = db
    .prepare("SELECT build, shape, generation, from_seq FROM stored_event_confirmed WHERE id = 1")
    .get();
  const keep =
    kept &&
    build !== undefined &&
    record?.build === build &&
    record.shape === shape &&
    record.generation === generation &&
    Number(record.from_seq) <= start;
  if (keep) {
    // Trusted: rows this module wrote.
    trust.from = Number(record.from_seq);
    for (const row of db.prepare("SELECT seq FROM stored_event_rejected").all())
      trust.rejected.add(Number(row.seq));
    return { generation, build };
  }
  db.exec("DELETE FROM stored_event_rejected; DELETE FROM stored_event_confirmed");
  if (build !== undefined)
    db.prepare("INSERT INTO stored_event_confirmed VALUES (1, ?, ?, ?, ?)").run(
      build,
      shape,
      generation,
      start,
    );
  trust.from = start;
  return { generation, build };
}

/**
 * Record that the pass confirmed every row from `from` on, apart from `rejected`, for what
 * `openStoredTrust` returned. Returns false, recording nothing, when another build recorded a
 * start since or the record was forgotten: what the pass holds no longer applies.
 */
export function recordStoredTrust(
  db: DatabaseSync,
  shape: string,
  opened: OpenedTrust,
  from: number,
  rejected: Iterable<number>,
): boolean {
  if (storedWriteGeneration(db) !== opened.generation) return false;
  if (opened.build === undefined) return true;
  const updated = db
    .prepare(
      "UPDATE stored_event_confirmed SET from_seq = ? WHERE id = 1 AND build = ? AND shape = ? AND generation = ?",
    )
    .run(from, opened.build, shape, opened.generation);
  if (updated.changes !== 1) return false;
  const reject = db.prepare("INSERT OR IGNORE INTO stored_event_rejected VALUES (?)");
  for (const seq of rejected) reject.run(seq);
  return true;
}

/**
 * Drop what the pass confirmed. Any code that rewrites `events`, `items`, `item_previews` or
 * `history_item_revisions` with raw SQL, rather than from a validated value, must call it in
 * the same transaction (ADR 0125), and run before `openStoredTrust` at open.
 */
export function forgetStoredTrust(db: DatabaseSync): void {
  createTables(db);
  db.exec("DELETE FROM stored_event_rejected; DELETE FROM stored_event_confirmed");
}
