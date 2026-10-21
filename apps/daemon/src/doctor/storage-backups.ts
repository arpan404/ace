import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DatabaseSync } from "@ace/provider-kit/sqlite";

/**
 * Before upgrading a database's schema the daemon writes a consistent copy beside it, named
 * `<database>.schema-<old version>.backup`, first under `.partial` (apps/daemon/src/migrations.ts).
 * Nothing reads it again unless a person rolls back by hand, and nothing deletes it.
 */
const BACKUP_NAME = /^([A-Za-z0-9][A-Za-z0-9._-]*\.sqlite)\.schema-(\d{1,6})\.backup(\.partial)?$/;
/** A `.partial` untouched this long is from an upgrade that was cut short, not one running now. */
export const ABANDONED_PARTIAL_MS = 60 * 60_000;

export type Backup = {
  name: string;
  path: string;
  bytes: number;
  /** The database it was copied from, such as `events.sqlite`. */
  database: string;
  /** The schema it holds. */
  version: number;
  partial: boolean;
  /** Why it must stay; undefined when the current database has moved past it. */
  kept?: string;
};

const Version = z.object({ version: z.number().int().nonnegative() });

/** The schema version a database records, or undefined when it doesn't open or has none. */
export function schemaVersion(path: string): number | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .get();
    if (!table) return undefined;
    const row = Version.safeParse(
      db.prepare("SELECT version FROM schema_version WHERE id = 1").get(),
    );
    return row.success ? row.data.version : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

/** Why `name` in `dataDir` must stay right now, or undefined when it's safe to delete. */
function keepReason(
  dataDir: string,
  backup: Omit<Backup, "kept">,
  modifiedAt: number,
  now: number,
): string | undefined {
  if (backup.partial)
    return now - modifiedAt < ABANDONED_PARTIAL_MS
      ? "an upgrade may still be writing it"
      : undefined;
  if (schemaVersion(backup.path) !== backup.version)
    return `it doesn't open as a schema-${backup.version} database`;
  const current = schemaVersion(join(dataDir, backup.database));
  if (current === undefined) return `${backup.database} doesn't open, so this may be the only copy`;
  if (current <= backup.version)
    return `${backup.database} is still on schema ${current}, so this copy may be needed`;
  return undefined;
}

/** One backup by name, re-read from disk; undefined when it isn't a backup file anymore. */
export function readBackup(dataDir: string, name: string, now: number): Backup | undefined {
  const match = BACKUP_NAME.exec(name);
  if (!match) return undefined;
  const [, database, version, partial] = match;
  if (!database || !version) return undefined;
  const path = join(dataDir, name);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return undefined;
  }
  // Links and folders are never ours to delete.
  if (!stat.isFile()) return undefined;
  const backup = {
    name,
    path,
    bytes: stat.size,
    database,
    version: Number(version),
    partial: partial !== undefined,
  };
  const kept = keepReason(dataDir, backup, stat.mtimeMs, now);
  return kept ? { ...backup, kept } : backup;
}

/** Every database backup left in the data folder, largest first. */
export function findBackups(dataDir: string, now: number): Backup[] {
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => BACKUP_NAME.test(name))
    .flatMap((name) => readBackup(dataDir, name, now) ?? [])
    .toSorted((a, b) => b.bytes - a.bytes);
}

/** An update journal in the data folder means an update stopped ace and is migrating its data. */
export function updateInProgress(dataDir: string): boolean {
  return existsSync(join(dataDir, "update.json"));
}
