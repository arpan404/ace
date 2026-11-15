import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Event } from "@ace/protocol";
import { z } from "zod";
import type { StoredTrust } from "./stored-decode.ts";

/**
 * Which stored rows this build may read back without validating them again (ADR 0125).
 *
 * The writer validates every event before it stores it, so a row this build wrote is already
 * in this build's shape. A row another build wrote may not be: a newer schema can add a field
 * with a default, rename a variant, or change a transform the shape can't show. The shape is a
 * fingerprint of the event schema and the migration version; the build (`storedTrustBuild`) is
 * the release's identity. When either differs from what is recorded, the first sequence this
 * build writes is recorded; rows from there on are trusted. Rows before it are decoded as before
 * until the idle pass (`stored-trust-pass.ts`) confirms them, newest first. So after every
 * update older history reads validated until the pass has re-confirmed it. A daemon run from
 * source has no build identity and records a new start at every open.
 *
 * The start and what the pass confirmed belong to one build and one write generation.
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
 * The identity stored-row trust is kept under: the release version (`ACE_VERSION`) and the
 * build id the release bundle step wrote beside the daemon (`runningBuildId`), a digest of every
 * daemon file it shipped, helpers and native assets included. Any change to the shipped code, a
 * protocol transform included, changes it, while a rebuild of identical files keeps it.
 * Undefined for a daemon run from source or a release without a readable id, so nothing it
 * trusted outlives it.
 */
export function storedTrustBuild(
  version: string | undefined,
  buildId: string | undefined,
): string | undefined {
  if (!version || version === "development" || !buildId) return undefined;
  return createHash("sha256").update(`${version}\n${buildId}`).digest("hex");
}

/** The file the release bundle step writes beside `ace.mjs` (`tools/release/src/build-id.ts`). */
export const buildIdFile = "build-id";
const BuildId = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * The build id of the release whose files sit in `directory`: the daemon's entry passes its
 * own directory, a bundled worker its own, which is the same one. Undefined from source.
 */
export function runningBuildId(directory: string): string | undefined {
  try {
    return BuildId.safeParse(readFileSync(join(directory, buildIdFile), "utf8").trim()).data;
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

const head = (db: DatabaseSync) =>
  z
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
/**
 * Record a start for `shape`: the first sequence this build will write. Items keep the sequence
 * they were created at, so the same boundary applies to them. Bumps the write generation.
 */
function recordStart(db: DatabaseSync, shape: string): number {
  const start = head(db) + 1;
  db.prepare(
    "INSERT INTO stored_event_shape VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET shape = excluded.shape, first_seq = excluded.first_seq",
  ).run(shape, start);
  return start;
}

/** What is recorded now, when it is this build's own: its start and what the pass confirmed. */
function ownRecord(
  db: DatabaseSync,
  shape: string,
  build: string | undefined,
): { generation: number; from: number } | undefined {
  createTables(db);
  if (build === undefined) return undefined;
  const recorded = Recorded.safeParse(
    db.prepare("SELECT shape, first_seq FROM stored_event_shape WHERE id = 1").get(),
  );
  const generation = storedWriteGeneration(db);
  const record = db
    .prepare("SELECT build, shape, generation, from_seq FROM stored_event_confirmed WHERE id = 1")
    .get();
  if (
    !recorded.success ||
    recorded.data.shape !== shape ||
    record?.build !== build ||
    record.shape !== shape ||
    record.generation !== generation ||
    Number(record.from_seq) > recorded.data.first_seq
  )
    return undefined;
  // Trusted: rows this module wrote.
  return { generation, from: Number(record.from_seq) };
}
function loadRejected(db: DatabaseSync, trust: StoredTrust): void {
  // Trusted: rows this module wrote.
  for (const row of db.prepare("SELECT seq FROM stored_event_rejected").all())
    trust.rejected.add(Number(row.seq));
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
 * this shape and build on, and the older rows the idle pass confirmed in this build and
 * generation, minus those it rejected. Any other shape or build records a new start above the
 * head. Anything else recorded is dropped, so a change only means the pass runs
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
  const own = ownRecord(db, shape, build);
  if (own) {
    trust.from = own.from;
    loadRejected(db, trust);
    return { generation: own.generation, build };
  }
  // Another shape or another build: even rows written above the old start may read
  // differently under this build's code, so trust starts above the head again.
  const start = recordStart(db, shape);
  const generation = storedWriteGeneration(db);
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
 * Set `trust` for a second connection of the same build that writes no trust record, such as
 * the history publication worker: what the daemon's own open recorded for this build, or
 * nothing at all.
 */
export function readStoredTrust(
  db: DatabaseSync,
  shape: string,
  build: string | undefined,
  trust: StoredTrust,
): void {
  trust.from = Number.POSITIVE_INFINITY;
  trust.rejected.clear();
  const own = ownRecord(db, shape, build);
  if (!own) return;
  trust.from = own.from;
  loadRejected(db, trust);
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
