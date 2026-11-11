import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
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
 * Put every entity row in `shape` and record it; true when every row is in `shape`. Run after
 * the migrations that write entity rows, inside a transaction. A row that no longer decodes is
 * left as it is and the shape isn't recorded, so rows stay decoded (and that row keeps failing
 * its reads, as before) and the next open tries again.
 */
export function canonicalEntities(db: DatabaseSync, shape: string): boolean {
  db.exec(`CREATE TABLE IF NOT EXISTS stored_entity_shape (
    id INTEGER PRIMARY KEY CHECK(id = 1), shape TEXT NOT NULL
  )`);
  const recorded = Recorded.safeParse(
    db.prepare("SELECT shape FROM stored_entity_shape WHERE id = 1").get(),
  );
  if (recorded.success && recorded.data.shape === shape) return true;
  const rewrite = db.prepare("UPDATE view_entities SET value = ? WHERE rowid = ?");
  let decodable = true;
  for (const row of db.prepare("SELECT rowid, collection, value FROM view_entities").iterate()) {
    const collection = String(row.collection);
    // A collection this build doesn't read is left to whatever reads it.
    if (!isCollection(collection)) continue;
    let stored: unknown;
    let decoded: unknown;
    try {
      stored = JSON.parse(String(row.value));
      decoded = decodeStoredEntity(collection, stored);
    } catch {
      decodable = false;
      continue;
    }
    if (!isDeepStrictEqual(decoded, stored))
      rewrite.run(JSON.stringify(decoded), Number(row.rowid));
  }
  if (!decodable) return false;
  db.prepare(
    "INSERT INTO stored_entity_shape VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET shape = excluded.shape",
  ).run(shape);
  return true;
}
