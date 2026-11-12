import type { DatabaseSync } from "@ace/provider-kit/sqlite";
import { migrationsFrom, schemaVersionBefore } from "./migrations.ts";

/*
 * Puts a database built at today's schema back to the release before `step`, so an upgrade test
 * can run `step` and every step after it again. What each later step added to a table (columns,
 * indexes, triggers) is undone here, newest step first, so a step added later needs nothing from
 * the tests that rewind past it. The stamps saying which stored rows today's build wrote go too.
 * Tables are left to the test, since some exist before the step that first declares them. Rewind
 * before dropping any: dropping a column rechecks triggers that may name them.
 */

type Step = Parameters<typeof schemaVersionBefore>[0];

const createdIndex = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;
const createdTrigger = /CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;
const addedColumn = /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi;

/** Put the database back to the release before `step` (see the note above). */
export function rewindSchema(db: DatabaseSync, step: Step): void {
  rewindSchemaTo(db, schemaVersionBefore(step));
}

/** Put the database back to schema `version`: undo every step after it, newest first. */
export function rewindSchemaTo(db: DatabaseSync, version: number): void {
  for (const sql of migrationsFrom(version).toReversed()) {
    if (typeof sql !== "string") continue;
    for (const [, name] of sql.matchAll(createdTrigger)) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    for (const [, name] of sql.matchAll(createdIndex)) db.exec(`DROP INDEX IF EXISTS ${name}`);
    for (const [, table, column] of sql.matchAll(addedColumn))
      if (hasColumn(db, table ?? "", column ?? ""))
        db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
  // An older build stamped no shape of today's: every row it left is read as untrusted again.
  db.exec(`DROP TABLE IF EXISTS stored_event_shape;
    DROP TABLE IF EXISTS thread_row_shape;
    DROP TABLE IF EXISTS thread_row_trust;
    DROP TABLE IF EXISTS stored_entity_shape;`);
  db.prepare("UPDATE schema_version SET version=?").run(version);
}

/** The schema just before the step whose SQL contains `fragment`, for a step with no name. */
export function versionBeforeStep(fragment: string): number {
  const index = migrationsFrom(0).findIndex(
    (sql) => typeof sql === "string" && sql.includes(fragment),
  );
  if (index < 0) throw new Error(`No migration step contains ${fragment}`);
  return index;
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}
