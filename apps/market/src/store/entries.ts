import { entryState as computeState, sameState } from "../rules.ts";
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

/**
 * Recomputes the entry from its versions and writes it if anything a reader sees changed: its
 * words, latest version, review or whether it is listed. Leaving the index records a removal;
 * coming back clears it.
 */
export async function refreshEntry(
  db: D1Database,
  type: string,
  name: string,
  now: number,
): Promise<void> {
  const row = await db
    .prepare("SELECT * FROM entries WHERE type = ?1 AND name = ?2")
    .bind(type, name)
    .first<EntryTable>();
  if (!row) return;
  const before = entryState(row);
  const after = computeState(name, await versionsOf(db, type, name));
  if (sameState(before, after)) return;
  const statements = [
    takeStamp(db, now),
    db
      .prepare(
        `UPDATE entries SET title = ?3, line = ?4, description = ?5, categories = ?6,
          keywords = ?7, latest = ?8, reviewed = ?9, by_ace = ?10, listed = ?11,
          updated = ${stampValue} WHERE type = ?1 AND name = ?2`,
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
      ),
  ];
  if (before.listed && !after.listed)
    statements.push(
      db
        .prepare(
          `INSERT INTO removals (type, name, stamp) VALUES (?1, ?2, ${stampValue})
            ON CONFLICT (type, name) DO UPDATE SET stamp = excluded.stamp`,
        )
        .bind(type, name),
    );
  if (after.listed)
    statements.push(
      db.prepare("DELETE FROM removals WHERE type = ?1 AND name = ?2").bind(type, name),
    );
  await db.batch(statements);
}
