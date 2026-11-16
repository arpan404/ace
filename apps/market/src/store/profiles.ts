import type {
  MarketEntryRef,
  MarketLink,
  MarketProfile,
  MarketVerificationProof,
} from "@ace/protocol/marketplace";

/* Publishers' profiles in D1 (ADR 0173 §3): handles, skeletons, retired handles, pins, avatars. */

/** A publisher row as this Worker wrote it (ADR 0125). */
export interface PublisherTable {
  id: string;
  account: string;
  name: string;
  created: number;
  skeleton: string | null;
  display_name: string;
  bio: string;
  links: string;
  avatar: string | null;
  verified: number;
  state: string;
  state_reason: string | null;
  pins: string;
  live_versions: number;
  verification: string;
  proofs: string;
  verification_reason: string | null;
  verification_flag: string | null;
  verification_at: number | null;
  rechecked: number;
}

export async function publisherById(
  db: D1Database,
  id: string,
): Promise<PublisherTable | undefined> {
  return (
    (await db.prepare("SELECT * FROM publishers WHERE id = ?1").bind(id).first<PublisherTable>()) ??
    undefined
  );
}

export async function publisherByHandle(
  db: D1Database,
  handle: string,
): Promise<PublisherTable | undefined> {
  return (
    (await db
      .prepare("SELECT * FROM publishers WHERE name = ?1")
      .bind(handle)
      .first<PublisherTable>()) ?? undefined
  );
}

export const pinsOf = (row: PublisherTable) => JSON.parse(row.pins) as MarketEntryRef[];
export const proofsOf = (row: PublisherTable) =>
  JSON.parse(row.proofs) as MarketVerificationProof[];

/** The public profile: its verified mark and proofs are what the signer's route stored. */
export function profileOf(row: PublisherTable): MarketProfile {
  return {
    id: row.id,
    handle: row.name,
    displayName: row.display_name || row.name,
    bio: row.bio,
    links: JSON.parse(row.links) as MarketLink[],
    ...(row.avatar ? { avatar: row.avatar } : {}),
    joined: row.created,
    verified: row.verified === 1,
    proofs: row.verified === 1 ? proofsOf(row) : [],
    pins: pinsOf(row),
  };
}

/**
 * Whether a handle, or any handle with its skeleton, is someone else's: a publisher's now, or
 * one retired by another publisher. A publisher may take back its own retired handle.
 */
export async function handleTaken(
  db: D1Database,
  handle: string,
  skeleton: string,
  self: string | undefined,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM publishers WHERE (name = ?1 OR skeleton = ?2) AND id != ?3
        UNION ALL SELECT 1 FROM retired_handles WHERE skeleton = ?2 AND publisher != ?3
        LIMIT 1`,
    )
    .bind(handle, skeleton, self ?? "")
    .first<{ found: number }>();
  return row !== null;
}

/** Display names of verified publishers, for the impersonation rule. */
export async function verifiedNames(
  db: D1Database,
): Promise<{ handle: string; displayName: string }[]> {
  const { results } = await db
    .prepare("SELECT name, display_name FROM publishers WHERE verified = 1 LIMIT 5000")
    .all<{ name: string; display_name: string }>();
  return results.map((row) => ({ handle: row.name, displayName: row.display_name || row.name }));
}

export interface NewProfile {
  id: string;
  account: string;
  handle: string;
  skeleton: string;
  displayName: string;
  bio: string;
  links: readonly MarketLink[];
  now: number;
}

const isUniqueFailure = (error: unknown) =>
  error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

/** Makes the account's profile; false when its handle or skeleton was taken first. */
export async function createProfile(db: D1Database, input: NewProfile): Promise<boolean> {
  try {
    const result = await db
      .prepare(
        `INSERT INTO publishers (id, account, name, created, skeleton, display_name, bio, links)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(
        input.id,
        input.account,
        input.handle,
        input.now,
        input.skeleton,
        input.displayName,
        input.bio,
        JSON.stringify(input.links),
      )
      .run();
    return result.meta.changes === 1;
  } catch (error) {
    if (isUniqueFailure(error)) return false;
    throw error;
  }
}

export async function updateProfile(
  db: D1Database,
  id: string,
  fields: {
    displayName?: string | undefined;
    bio?: string | undefined;
    links?: readonly MarketLink[] | undefined;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE publishers SET display_name = COALESCE(?2, display_name), bio = COALESCE(?3, bio),
        links = COALESCE(?4, links) WHERE id = ?1`,
    )
    .bind(
      id,
      fields.displayName ?? null,
      fields.bio ?? null,
      fields.links ? JSON.stringify(fields.links) : null,
    )
    .run();
}

/**
 * Moves a publisher to a new handle. The old one is retired for the publisher, so nobody else
 * can take it; taking back one of its own retired handles un-retires it. False when another
 * request took the handle first.
 */
export async function changeHandle(
  db: D1Database,
  publisher: { id: string; name: string; skeleton: string },
  next: { handle: string; skeleton: string },
  now: number,
): Promise<boolean> {
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO retired_handles (skeleton, handle, publisher, at) VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT (skeleton) DO NOTHING`,
        )
        .bind(publisher.skeleton, publisher.name, publisher.id, now),
      db
        .prepare("DELETE FROM retired_handles WHERE skeleton = ?1 AND publisher = ?2")
        .bind(next.skeleton, publisher.id),
      db
        .prepare("UPDATE publishers SET name = ?2, skeleton = ?3 WHERE id = ?1")
        .bind(publisher.id, next.handle, next.skeleton),
    ]);
    return true;
  } catch (error) {
    if (isUniqueFailure(error)) return false;
    throw error;
  }
}

export async function setAvatar(db: D1Database, id: string, sha256: string): Promise<void> {
  await db.prepare("UPDATE publishers SET avatar = ?2 WHERE id = ?1").bind(id, sha256).run();
}

export async function setPins(
  db: D1Database,
  id: string,
  pins: readonly MarketEntryRef[],
): Promise<void> {
  await db
    .prepare("UPDATE publishers SET pins = ?2 WHERE id = ?1")
    .bind(id, JSON.stringify(pins))
    .run();
}

/** Takes an entry off a publisher's pins: when it moves to another publisher or is deleted. */
export const unpinStatement = (db: D1Database, publisher: string, entry: MarketEntryRef) =>
  db
    .prepare(
      `UPDATE publishers SET pins = (
          SELECT COALESCE(json_group_array(json(value)), '[]') FROM json_each(publishers.pins)
          WHERE NOT (json_extract(value, '$.type') = ?2 AND json_extract(value, '$.name') = ?3))
        WHERE id = ?1`,
    )
    .bind(publisher, entry.type, entry.name);

/** Which of `entries` are the publisher's own and in the index now. */
export async function ownListed(
  db: D1Database,
  publisher: string,
  entries: readonly MarketEntryRef[],
): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT type, name FROM entries WHERE publisher = ?1 AND listed = 1
        AND (type || '/' || name) IN (SELECT value FROM json_each(?2))`,
    )
    .bind(publisher, JSON.stringify(entries.map((entry) => `${entry.type}/${entry.name}`)))
    .all<MarketEntryRef>();
  return new Set(results.map((row) => `${row.type}/${row.name}`));
}
