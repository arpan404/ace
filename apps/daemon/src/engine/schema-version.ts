import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { IncompatibleDataError } from "@ace/provider-kit/incompatible-data";

/** Pre-release engine databases are disposable; no legacy snapshot migration is supported. */
export const engineSchemaVersion = 9;
const databaseVersion = z.object({ version: z.literal(engineSchemaVersion) });
const snapshotVersion = z.object({ engineSnapshot: z.literal(engineSchemaVersion) });
const recovery = "Quit ace, then start it with a fresh ACE_HOME.";

function location(db: DatabaseSync | undefined): string {
  return db?.location() ?? "the daemon database";
}

export function requireEngineVersion(row: unknown, db?: DatabaseSync): void {
  if (!databaseVersion.safeParse(row).success)
    throw new IncompatibleDataError(
      location(db),
      `Unsupported engine schema version: expected ${engineSchemaVersion}`,
      recovery,
    );
}

export function requireSnapshotVersion(value: unknown, db?: DatabaseSync): void {
  if (!snapshotVersion.safeParse(value).success)
    throw new IncompatibleDataError(
      location(db),
      `Unsupported engine snapshot format: expected ${engineSchemaVersion}`,
      recovery,
    );
}

/** An engine table created by an older pre-release build lacks current columns; refuse it. */
export function requireEngineColumns(
  db: DatabaseSync,
  table: string,
  columns: readonly string[],
): void {
  const present = new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name)),
  );
  const missing = columns.filter((name) => !present.has(name));
  if (missing.length)
    throw new IncompatibleDataError(
      location(db),
      `The engine table ${table} lacks ${missing.join(", ")}`,
      recovery,
    );
}
