import { canonicalJson } from "@ace/marketplace";
import type { MarketOfficialList, MarketVerifiedList, Signed } from "@ace/protocol/marketplace";
import { refreshEntry } from "./entries.ts";
import { signedOf } from "./rows.ts";

/*
 * The signed lists besides the withdrawn one (ADR 0173 §8, §13, §14): the blocklist, the
 * verified publishers and the official list. Each keeps only its newest `issued`, and stores an
 * edit only while the list it was based on is still the stored one; any other upload changes
 * nothing. The Worker checked each signature before calling.
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

/**
 * The text a signed list is stored and compared as: its canonical JSON (keys sorted, no spaces),
 * so the same list sent again with its properties in another order is the same list.
 */
export const signedText = (signed: Signed): string => canonicalJson(signed);

/** Where a signed list is kept: one row, id 1. */
export type SignedTable = ListTable | "withdrawn";

/**
 * Stores a list in one statement, only while the stored list is still the one the edit started
 * from (`basedOn` its `issued`, null when none was stored) and only when it is newer, so two
 * maintainers editing at once never undo each other.
 */
export const upsertSigned = (
  db: D1Database,
  table: SignedTable,
  list: { issued: number; signed: string; basedOn?: number | undefined },
) =>
  db
    .prepare(
      `INSERT INTO ${table} (id, issued, signed)
        SELECT 1, ?1, ?2 WHERE ?3 IS NULL OR EXISTS (SELECT 1 FROM ${table} WHERE id = 1 AND issued = ?3)
        ON CONFLICT (id) DO UPDATE SET issued = excluded.issued, signed = excluded.signed
        WHERE excluded.issued > ${table}.issued AND ${table}.issued IS ?3`,
    )
    .bind(list.issued, list.signed, list.basedOn ?? null);
const guard = (table: ListTable) =>
  `(SELECT issued = ?1 AND signed = ?2 FROM ${table} WHERE id = 1)`;

/**
 * What became of an upload: stored (this very list is the stored one, so sending it again is
 * fine), changed (the stored list isn't the one the edit read) or older.
 */
export type ListStored = "stored" | "changed" | "older";

export async function listOutcome(
  db: D1Database,
  table: SignedTable,
  list: { issued: number; signed: string; basedOn?: number | undefined },
): Promise<ListStored> {
  const stored = await db
    .prepare(`SELECT issued, signed FROM ${table} WHERE id = 1`)
    .first<{ issued: number; signed: string }>();
  if (stored?.issued === list.issued && stored.signed === list.signed) return "stored";
  return stored?.issued !== list.basedOn ? "changed" : "older";
}

/** Stores the blocklist when it is newer than, and based on, the stored one. */
export async function setBlocklist(
  db: D1Database,
  list: { issued: number; signed: string; basedOn?: number | undefined },
): Promise<ListStored> {
  await upsertSigned(db, "blocklist", list).run();
  return listOutcome(db, "blocklist", list);
}

/**
 * Stores the verified list and marks publishers by it in the same batch: those on it verified,
 * with their proofs as both the approved ones and the application's; those who were verified and aren't any more revoked, with the reason a
 * maintainer gave. The entries of every publisher whose mark changes move their generation in
 * the same batch, so a refresh that read the old mark can't write it back. Every entry whose
 * verified mark differs from its publisher's is brought in step after, so sending the same list
 * again finishes an upload cut off part way.
 */
export async function setVerified(
  db: D1Database,
  list: { body: MarketVerifiedList; signed: string; basedOn?: number | undefined },
  revoked: readonly { handle: string; reason: string }[],
  now: number,
): Promise<ListStored> {
  const on = JSON.stringify(list.body.publishers);
  const ids = JSON.stringify(list.body.publishers.map((publisher) => publisher.id));
  const reasons = JSON.stringify(revoked);
  const stored = { issued: list.body.issued, signed: list.signed, basedOn: list.basedOn };
  const g = guard("verified");
  await db.batch([
    upsertSigned(db, "verified", stored),
    db
      .prepare(
        `UPDATE entries SET generation = generation + 1 WHERE ${g} AND publisher IN (
          SELECT id FROM publishers WHERE (verified = 0) = (id IN (SELECT value FROM json_each(?3))))`,
      )
      .bind(list.body.issued, list.signed, ids),
    db
      .prepare(
        `UPDATE publishers SET verified = 1, verification = 'verified',
            proofs = (SELECT json_extract(value, '$.proofs') FROM json_each(?3)
              WHERE json_extract(value, '$.id') = publishers.id),
            approved_proofs = (SELECT json_extract(value, '$.proofs') FROM json_each(?3)
              WHERE json_extract(value, '$.id') = publishers.id),
            verification_at = (SELECT json_extract(value, '$.at') FROM json_each(?3)
              WHERE json_extract(value, '$.id') = publishers.id),
            verification_reason = NULL, verification_flag = NULL
          WHERE ${g} AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?3))`,
      )
      .bind(list.body.issued, list.signed, on),
    db
      .prepare(
        `UPDATE publishers SET verified = 0, verification = 'revoked', approved_proofs = '[]',
            verification_reason = COALESCE((SELECT json_extract(value, '$.reason')
              FROM json_each(?3) WHERE json_extract(value, '$.handle') = publishers.name),
              verification_reason)
          WHERE ${g} AND verified = 1 AND id NOT IN (SELECT value FROM json_each(?4))`,
      )
      .bind(list.body.issued, list.signed, reasons, ids),
  ]);
  const outcome = await listOutcome(db, "verified", stored);
  if (outcome !== "stored") return outcome;
  const { results } = await db
    .prepare(
      `SELECT e.type, e.name FROM entries e JOIN publishers p ON p.id = e.publisher
        WHERE e.verified != p.verified`,
    )
    .all<{ type: string; name: string }>();
  for (const row of results) await refreshEntry(db, row.type, row.name, now);
  return outcome;
}

export type OfficialStored = ListStored | "publisher-taken";

/**
 * Stores the official list and copies its accounts into `official_accounts`, which the
 * publishing routes read on every request. The `ace` publisher is made from the list when it
 * doesn't exist yet; a different publisher already holding the handle refuses it.
 */
export async function setOfficial(
  db: D1Database,
  list: { body: MarketOfficialList; signed: string; basedOn?: number | undefined },
  now: number,
): Promise<OfficialStored> {
  const { publisher } = list.body;
  const holder = await db
    .prepare("SELECT id FROM publishers WHERE name = ?1")
    .bind(publisher.name)
    .first<{ id: string }>();
  if (holder && holder.id !== publisher.id) return "publisher-taken";
  const stored = { issued: list.body.issued, signed: list.signed, basedOn: list.basedOn };
  const g = guard("official");
  await db.batch([
    // The official publisher's own account is no person's: the list's accounts act as it.
    db
      .prepare(
        `INSERT INTO publishers (id, account, name, created, display_name)
          VALUES (?1, ?2, ?3, ?4, 'ace') ON CONFLICT DO NOTHING`,
      )
      .bind(publisher.id, `official:${publisher.id}`, publisher.name, now),
    upsertSigned(db, "official", stored),
    db.prepare(`DELETE FROM official_accounts WHERE ${g}`).bind(list.body.issued, list.signed),
    db
      .prepare(
        `INSERT INTO official_accounts (account, publisher)
          SELECT value, ?3 FROM json_each(?4) WHERE ${g}`,
      )
      .bind(list.body.issued, list.signed, publisher.id, JSON.stringify(list.body.accounts)),
  ]);
  return listOutcome(db, "official", stored);
}

/** The official publisher's id, from the stored list: its entries rank in the official tier. */
export async function officialPublisher(db: D1Database): Promise<string | undefined> {
  const row = await db
    .prepare("SELECT json_extract(signed, '$.body.publisher.id') AS id FROM official WHERE id = 1")
    .first<{ id: string | null }>();
  return row?.id ?? undefined;
}
