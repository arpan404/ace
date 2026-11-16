import {
  entryState as computeState,
  sameState,
  type EntryState,
  type StoredVersion,
} from "../rules.ts";
import { entryState, type EntryTable } from "./rows.ts";
import { versionsOf } from "./read.ts";

/*
 * Keeping an entry's row in step with its versions. Every visible change takes the next stamp,
 * which is strictly greater than the last and never behind the clock, inside the same
 * transaction as the change, so `since` never misses one.
 */

/** The statement that takes the next stamp; later statements in the batch read it back. */
export const takeStamp = (db: D1Database, now: number) =>
  db.prepare("UPDATE meta SET value = MAX(value + 1, ?1) WHERE key = 'stamp'").bind(now);
export const stampValue = "(SELECT value FROM meta WHERE key = 'stamp')";

/** Moves an entry's generation: batched with every change to its versions. */
export const bumpGeneration = (db: D1Database, type: string, name: string) =>
  db
    .prepare("UPDATE entries SET generation = generation + 1 WHERE type = ?1 AND name = ?2")
    .bind(type, name);

export interface EntrySnapshot {
  row: EntryTable;
  generation: number;
  versions: StoredVersion[];
}

/** The entry's row and its versions, with the generation they were read at. */
export async function readEntrySnapshot(
  db: D1Database,
  type: string,
  name: string,
): Promise<EntrySnapshot | undefined> {
  const row = await db
    .prepare("SELECT * FROM entries WHERE type = ?1 AND name = ?2")
    .bind(type, name)
    .first<EntryTable & { generation: number }>();
  if (!row) return undefined;
  return { row, generation: row.generation, versions: await versionsOf(db, type, name) };
}

export const computeEntry = computeState;

/**
 * Writes `after` as the entry's row, with a new stamp, only if its generation is still
 * `generation`: a write computed from versions another change has moved past does nothing and
 * answers false. Leaving the index records a removal; coming back clears it.
 */
export async function writeEntry(
  db: D1Database,
  type: string,
  name: string,
  after: EntryState,
  generation: number,
  now: number,
): Promise<boolean> {
  const current = `EXISTS (SELECT 1 FROM entries WHERE type = ?1 AND name = ?2 AND generation = ${Number(generation)})`;
  const update = db
    .prepare(
      `UPDATE entries SET title = ?3, line = ?4, description = ?5, categories = ?6,
        keywords = ?7, latest = ?8, reviewed = ?9, by_ace = ?10, listed = ?11,
        updated = ${stampValue} WHERE type = ?1 AND name = ?2 AND generation = ?12`,
    )
    .bind(
      type,
      name,
      after.title,
      after.line,
      after.description,
      JSON.stringify(after.categories),
      JSON.stringify(after.keywords),
      after.latest ?? null,
      after.reviewed ? 1 : 0,
      after.byAce ? 1 : 0,
      after.listed ? 1 : 0,
      generation,
    );
  // Read before the update in the same batch, so it sees whether the entry was listed.
  const removal = after.listed
    ? db
        .prepare(`DELETE FROM removals WHERE type = ?1 AND name = ?2 AND ${current}`)
        .bind(type, name)
    : db
        .prepare(
          `INSERT INTO removals (type, name, stamp) SELECT ?1, ?2, ${stampValue}
            WHERE ${current} AND EXISTS (SELECT 1 FROM entries WHERE type = ?1 AND name = ?2 AND listed = 1)
            ON CONFLICT (type, name) DO UPDATE SET stamp = excluded.stamp`,
        )
        .bind(type, name);
  const results = await db.batch([takeStamp(db, now), removal, update]);
  return (results[2]?.meta.changes ?? 0) === 1;
}

/**
 * Brings the entry's row in step with its versions: read, compute, write while nothing moved,
 * and read again when something did. A row already right is left alone.
 */
export async function refreshEntry(
  db: D1Database,
  type: string,
  name: string,
  now: number,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const snapshot = await readEntrySnapshot(db, type, name);
    if (!snapshot) return;
    const before = entryState(snapshot.row);
    const after = computeState(name, snapshot.versions);
    if (sameState(before, after)) {
      // Right as read; but only if nothing moved since, else look again.
      const still = await readEntrySnapshot(db, type, name);
      if (still?.generation === snapshot.generation) return;
      continue;
    }
    if (await writeEntry(db, type, name, after, snapshot.generation, now)) return;
  }
  throw new Error(`${type}/${name} kept changing while its row was brought in step`);
}
