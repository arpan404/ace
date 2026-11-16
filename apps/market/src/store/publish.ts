import type { Listing } from "@ace/marketplace";
import type { MarketPublisher } from "@ace/protocol/marketplace";

import { bumpGeneration } from "./entries.ts";

/* Publishers, and versions waiting for the signer. */

export async function publisherOf(
  db: D1Database,
  account: string,
): Promise<MarketPublisher | undefined> {
  const row = await db
    .prepare("SELECT id, name FROM publishers WHERE account = ?1")
    .bind(account)
    .first<MarketPublisher>();
  return row ? { id: row.id, name: row.name } : undefined;
}

export async function nameTaken(db: D1Database, name: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS found FROM publishers WHERE name = ?1")
    .bind(name)
    .first<{ found: number }>();
  return row !== null;
}

/** The publisher id that owns the entry, if it was ever published. */
export async function ownerOf(
  db: D1Database,
  type: string,
  name: string,
): Promise<string | undefined> {
  const row = await db
    .prepare("SELECT publisher FROM entries WHERE type = ?1 AND name = ?2")
    .bind(type, name)
    .first<{ publisher: string }>();
  return row?.publisher;
}

export async function storedVersion(
  db: D1Database,
  key: { type: string; name: string; version: string },
): Promise<{ hash: string; size: number; published: number; listed: boolean } | undefined> {
  const row = await db
    .prepare(
      "SELECT hash, size, published, listed FROM versions WHERE type = ?1 AND name = ?2 AND version = ?3",
    )
    .bind(key.type, key.name, key.version)
    .first<{ hash: string; size: number; published: number; listed: number }>();
  return row
    ? { hash: row.hash, size: row.size, published: row.published, listed: row.listed === 1 }
    : undefined;
}

export type Claim =
  | { claimed: MarketPublisher }
  | { taken: "name" }
  | { taken: "account"; publisher: MarketPublisher };

/** Reserves `name` for `account` on its first publish. */
export async function claimPublisher(
  db: D1Database,
  input: { id: string; account: string; name: string; now: number },
): Promise<Claim> {
  const result = await db
    .prepare(
      "INSERT INTO publishers (id, account, name, created) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING",
    )
    .bind(input.id, input.account, input.name, input.now)
    .run();
  if (result.meta.changes === 1) return { claimed: { id: input.id, name: input.name } };
  // Another request for the same account may have claimed first.
  const existing = await publisherOf(db, input.account);
  return existing ? { taken: "account", publisher: existing } : { taken: "name" };
}

/**
 * Stores a checked version, unlisted, creating its entry for `publisher` if it is new. Returns
 * the entry's owner and the version's hash as stored, which differ from the input when another
 * request got there first.
 */
export async function storePending(
  db: D1Database,
  input: {
    publisher: string;
    type: string;
    name: string;
    version: string;
    hash: string;
    size: number;
    published: number;
    listing: Listing;
  },
): Promise<{ owner: string | undefined; hash: string | undefined }> {
  await db.batch([
    db
      .prepare(
        "INSERT INTO entries (type, name, publisher, title) VALUES (?1, ?2, ?3, ?2) ON CONFLICT DO NOTHING",
      )
      .bind(input.type, input.name, input.publisher),
    db
      .prepare(
        `INSERT INTO versions (type, name, version, hash, size, published, listing)
          SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
          WHERE EXISTS (SELECT 1 FROM entries WHERE type = ?1 AND name = ?2 AND publisher = ?8)
          ON CONFLICT DO NOTHING`,
      )
      .bind(
        input.type,
        input.name,
        input.version,
        input.hash,
        input.size,
        input.published,
        JSON.stringify(input.listing),
        input.publisher,
      ),
    bumpGeneration(db, input.type, input.name),
  ]);
  const [owner, stored] = await Promise.all([
    ownerOf(db, input.type, input.name),
    storedVersion(db, input),
  ]);
  return { owner, hash: stored?.hash };
}

export async function addWithdrawal(
  db: D1Database,
  input: { type: string; name: string; version: string; hash: string; reason: string; at: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pending_withdrawals (type, name, version, hash, reason, at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT (type, name, version) DO UPDATE SET reason = excluded.reason, at = excluded.at`,
    )
    .bind(input.type, input.name, input.version, input.hash, input.reason, input.at)
    .run();
}
