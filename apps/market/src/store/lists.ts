import type { MarketOfficialList, MarketVerifiedList, Signed } from "@ace/protocol/marketplace";
import { refreshPublisherEntries } from "./entries.ts";
import { signedOf } from "./rows.ts";

/*
 * The signed lists besides the withdrawn one (ADR 0173 §8, §13, §14): the blocklist, the
 * verified publishers and the official list. Each keeps only its newest `issued`; an upload
 * older than the stored one changes nothing. The Worker checked each signature before calling.
 */

export type ListTable = "blocklist" | "verified" | "official";

export async function signedList(
  db: D1Database,
  table: ListTable,
): Promise<{ issued: number; signed: Signed } | undefined> {
  const row = await db
    .prepare(`SELECT issued, signed FROM ${table} WHERE id = 1`)
    .first<{ issued: number; signed: string }>();
  return row ? { issued: row.issued, signed: signedOf(row.signed) as Signed } : undefined;
}

const upsert = (db: D1Database, table: ListTable, issued: number, signed: string) =>
  db
    .prepare(
      `INSERT INTO ${table} (id, issued, signed) VALUES (1, ?1, ?2)
        ON CONFLICT (id) DO UPDATE SET issued = excluded.issued, signed = excluded.signed
        WHERE excluded.issued > ${table}.issued`,
    )
    .bind(issued, signed);
const guard = (table: ListTable) =>
  `(SELECT issued = ?1 AND signed = ?2 FROM ${table} WHERE id = 1)`;

async function isStored(db: D1Database, table: ListTable, issued: number, signed: string) {
  const stored = await db
    .prepare(`SELECT issued, signed FROM ${table} WHERE id = 1`)
    .first<{ issued: number; signed: string }>();
  return stored?.issued === issued && stored.signed === signed;
}

/** Stores the blocklist; false when a list issued at or after it is already stored. */
export async function setBlocklist(db: D1Database, issued: number, signed: string) {
  await upsert(db, "blocklist", issued, signed).run();
  return isStored(db, "blocklist", issued, signed);
}

/**
 * Stores the verified list and marks publishers by it in the same batch: those on it verified,
 * with their proofs; those who were verified and aren't any more revoked, with the reason a
 * maintainer gave. Their entries are brought in step after.
 */
export async function setVerified(
  db: D1Database,
  list: { body: MarketVerifiedList; signed: string },
  revoked: readonly { handle: string; reason: string }[],
  now: number,
): Promise<boolean> {
  const on = JSON.stringify(list.body.publishers);
  const ids = JSON.stringify(list.body.publishers.map((publisher) => publisher.id));
  const reasons = JSON.stringify(revoked);
  const changed = async () =>
    (
      await db
        .prepare(
          `SELECT id FROM publishers WHERE verified = 1
            OR id IN (SELECT value FROM json_each(?1))`,
        )
        .bind(ids)
        .all<{ id: string }>()
    ).results.map((row) => row.id);
  const before = await changed();
  const g = guard("verified");
  await db.batch([
    upsert(db, "verified", list.body.issued, list.signed),
    db
      .prepare(
        `UPDATE publishers SET verified = 1, verification = 'verified',
            proofs = (SELECT json_extract(value, '$.proofs') FROM json_each(?3)
              WHERE json_extract(value, '$.id') = publishers.id),
            verification_at = (SELECT json_extract(value, '$.at') FROM json_each(?3)
              WHERE json_extract(value, '$.id') = publishers.id),
            verification_reason = NULL, verification_flag = NULL
          WHERE ${g} AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?3))`,
      )
      .bind(list.body.issued, list.signed, on),
    db
      .prepare(
        `UPDATE publishers SET verified = 0, verification = 'revoked',
            verification_reason = COALESCE((SELECT json_extract(value, '$.reason')
              FROM json_each(?3) WHERE json_extract(value, '$.handle') = publishers.name),
              verification_reason)
          WHERE ${g} AND verified = 1 AND id NOT IN (SELECT value FROM json_each(?4))`,
      )
      .bind(list.body.issued, list.signed, reasons, ids),
  ]);
  if (!(await isStored(db, "verified", list.body.issued, list.signed))) return false;
  for (const id of new Set([...before, ...(await changed())]))
    await refreshPublisherEntries(db, id, now);
  return true;
}

export type OfficialStored = "stored" | "older" | "publisher-taken";

/**
 * Stores the official list and copies its accounts into `official_accounts`, which the
 * publishing routes read on every request. The `ace` publisher is made from the list when it
 * doesn't exist yet; a different publisher already holding the handle refuses it.
 */
export async function setOfficial(
  db: D1Database,
  list: { body: MarketOfficialList; signed: string },
  now: number,
): Promise<OfficialStored> {
  const { publisher } = list.body;
  const holder = await db
    .prepare("SELECT id FROM publishers WHERE name = ?1")
    .bind(publisher.name)
    .first<{ id: string }>();
  if (holder && holder.id !== publisher.id) return "publisher-taken";
  const g = guard("official");
  await db.batch([
    // The official publisher's own account is no person's: the list's accounts act as it.
    db
      .prepare(
        `INSERT INTO publishers (id, account, name, created, display_name)
          VALUES (?1, ?2, ?3, ?4, 'ace') ON CONFLICT DO NOTHING`,
      )
      .bind(publisher.id, `official:${publisher.id}`, publisher.name, now),
    upsert(db, "official", list.body.issued, list.signed),
    db.prepare(`DELETE FROM official_accounts WHERE ${g}`).bind(list.body.issued, list.signed),
    db
      .prepare(
        `INSERT INTO official_accounts (account, publisher)
          SELECT value, ?3 FROM json_each(?4) WHERE ${g}`,
      )
      .bind(list.body.issued, list.signed, publisher.id, JSON.stringify(list.body.accounts)),
  ]);
  return (await isStored(db, "official", list.body.issued, list.signed)) ? "stored" : "older";
}

/** The official publisher's id, from the stored list: its entries rank in the official tier. */
export async function officialPublisher(db: D1Database): Promise<string | undefined> {
  const row = await db
    .prepare("SELECT json_extract(signed, '$.body.publisher.id') AS id FROM official WHERE id = 1")
    .first<{ id: string | null }>();
  return row?.id ?? undefined;
}
