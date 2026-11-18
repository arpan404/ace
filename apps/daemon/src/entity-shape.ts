import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { storedWriteGeneration } from "./stored-shape.ts";
import {
  decodeStoredEntity,
  storedEntitySchemas,
  type StoredEntityCollection,
} from "./stored-decode.ts";

/**
 * Which build's shape the `view_entities` rows are in (ADR 0125).
 *
 * Unlike events, entity rows are rewritten in place as their entity changes, so a row's age
 * doesn't say which build wrote it last. Instead, when a build opens a store whose recorded
 * shape differs from its own, it rewrites every row its schemas would decode differently (an
 * older layout, a default a newer schema fills in) and then records its shape. From then on
 * every row is in this build's shape: its writer folds rows from validated events and values
 * read in this shape. The table is created at open, so it needs no migration step.
 */
export function storedEntityShape(schemaVersion: number): string {
  const hash = createHash("sha256").update(`${schemaVersion}\n`);
  for (const [collection, schema] of Object.entries(storedEntitySchemas))
    hash.update(
      `${collection}\n${JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any", io: "output", cycles: "ref" }))}\n`,
    );
  return hash.digest("hex");
}

const Recorded = z.object({ shape: z.string() });
const collections = new Set<string>(Object.keys(storedEntitySchemas));
const isCollection = (name: string): name is StoredEntityCollection => collections.has(name);

/**
 * The shape recorded when some rows didn't decode. A build with the same schemas from before
 * rows were rejected one by one would otherwise take the plain shape to mean every row is in
 * it; it sees a different value, so it checks every row again and trusts none it can't decode.
 * Such a build doesn't record its shape while a row fails it either, yet it may have rewritten
 * rows in its own shape, so this record also holds only while the write generation
 * (`stored-shape.ts`) is the one sealed at the end of this build's open: any other build that
 * opened since recorded its start and moved it.
 */
const withRejected = (shape: string) => `${shape}+rejected`;

/**
 * Put every entity row in `shape` and record it, then return the stored JSON of rows that don't
 * decode. Run after the migrations that write entity rows, inside a transaction.
 *
 * Only when the recorded shape differs does this read every row (once per change of the entity
 * schemas). A row that no longer decodes is kept as it is, its rowid listed in
 * `stored_entity_rejected`, and the shape is recorded all the same, so the next open reads only
 * the listed rows. Their values are always decoded on read, so such a row fails its reads as it
 * did before and every other row is read as stored. A listed row the writer has since rewritten
 * decodes again and leaves the list.
 */
export function canonicalEntities(db: DatabaseSync, shape: string): Set<string> {
  db.exec(`CREATE TABLE IF NOT EXISTS stored_entity_shape (
    id INTEGER PRIMARY KEY CHECK(id = 1), shape TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stored_entity_rejected (row INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS stored_entity_rejected_seal (
    id INTEGER PRIMARY KEY CHECK(id = 1), shape TEXT NOT NULL, generation INTEGER NOT NULL
  )`);
  const recorded = Recorded.safeParse(
    db.prepare("SELECT shape FROM stored_entity_shape WHERE id = 1").get(),
  );
  if (
    recorded.success &&
    (recorded.data.shape === shape ||
      (recorded.data.shape === withRejected(shape) && sealed(db, recorded.data.shape)))
  )
    return listedRejections(db, shape);
  db.exec("DELETE FROM stored_entity_rejected; DELETE FROM stored_entity_rejected_seal");
  const rewrite = db.prepare("UPDATE view_entities SET value = ? WHERE rowid = ?");
  const reject = db.prepare("INSERT OR IGNORE INTO stored_entity_rejected VALUES (?)");
  const rejected = new Set<string>();
  for (const row of db.prepare("SELECT rowid, collection, value FROM view_entities").iterate()) {
    const collection = String(row.collection);
    // A collection this build doesn't read is left to whatever reads it.
    if (!isCollection(collection)) continue;
    const decoded = decodeRow(collection, String(row.value));
    if (decoded === undefined) {
      reject.run(Number(row.rowid));
      rejected.add(String(row.value));
      continue;
    }
    if (!isDeepStrictEqual(decoded.value, decoded.stored))
      rewrite.run(JSON.stringify(decoded.value), Number(row.rowid));
  }
  record(db, rejected.size ? withRejected(shape) : shape);
  return rejected;
}

/** The listed rows still not decoding; rows since rewritten in this shape leave the list. */
function listedRejections(db: DatabaseSync, shape: string): Set<string> {
  const rejected = new Set<string>();
  const unlist = db.prepare("DELETE FROM stored_entity_rejected WHERE row = ?");
  for (const row of db
    .prepare(
      "SELECT listed.row, entity.collection, entity.value FROM stored_entity_rejected AS listed LEFT JOIN view_entities AS entity ON entity.rowid = listed.row",
    )
    .all()) {
    const collection = String(row.collection);
    const value = row.value === null ? undefined : String(row.value);
    const decoded =
      value !== undefined && isCollection(collection) ? decodeRow(collection, value) : undefined;
    // Gone, or decoding to exactly what is stored: in this build's shape now.
    if (value === undefined || (decoded && isDeepStrictEqual(decoded.value, decoded.stored)))
      unlist.run(Number(row.row));
    else rejected.add(value);
  }
  if (!rejected.size) record(db, shape);
  return rejected;
}

/**
 * After the open's stored-trust step has recorded this build's start: seal the rejected list at
 * the current write generation. Only the daemon's own connection seals.
 */
export function sealEntityRejections(db: DatabaseSync): void {
  db.prepare(
    "INSERT INTO stored_entity_rejected_seal SELECT 1, shape, ? FROM stored_entity_shape WHERE id = 1 AND EXISTS (SELECT 1 FROM stored_entity_rejected) ON CONFLICT(id) DO UPDATE SET shape = excluded.shape, generation = excluded.generation",
  ).run(storedWriteGeneration(db));
}

/** Whether `recorded` is the record sealed, and no other build recorded a start since. */
function sealed(db: DatabaseSync, recorded: string): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'stored_event_generation'").get())
    return false;
  const seal = db
    .prepare("SELECT shape, generation FROM stored_entity_rejected_seal WHERE id = 1")
    .get();
  return (
    seal !== undefined &&
    seal.shape === recorded &&
    Number(seal.generation) === storedWriteGeneration(db)
  );
}

/** The stored value parsed and decoded, or undefined when either fails. */
function decodeRow(
  collection: StoredEntityCollection,
  json: string,
): { stored: unknown; value: unknown } | undefined {
  try {
    const stored: unknown = JSON.parse(json);
    return { stored, value: decodeStoredEntity(collection, stored) };
  } catch {
    return undefined;
  }
}

function record(db: DatabaseSync, value: string): void {
  db.prepare(
    "INSERT INTO stored_entity_shape VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET shape = excluded.shape",
  ).run(value);
}
