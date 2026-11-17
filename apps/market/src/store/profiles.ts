import type {
  MarketEntryRef,
  MarketLink,
  MarketProfile,
  MarketVerificationProof,
} from "@ace/protocol/marketplace";
import { storedBytesSql } from "./me-limits.ts";

/*
 * Publishers' profiles in D1 (ADR 0173 §3): handles, skeletons, retired handles, pins, avatars,
 * and the pictures they stored, charged to their quota.
 */

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
  /** The latest application's proofs. */
  proofs: string;
  /** The proofs the signed verified list granted the mark on. */
  approved_proofs: string;
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
export const approvedProofsOf = (row: PublisherTable) =>
  JSON.parse(row.approved_proofs) as MarketVerificationProof[];

/**
 * The public profile: its verified mark and the proofs the mark was granted on, as the signer's
 * route stored them; a newer application's proofs aren't shown until a maintainer approves them.
 */
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
    proofs: row.verified === 1 ? approvedProofsOf(row) : [],
    pins: pinsOf(row),
  };
}

/**
 * Whether a handle, or any handle with its skeleton, is someone else's: a publisher's now, or
 * one retired by another publisher. A publisher may take back its own retired handle. This is
 * the early answer for a request; the write itself is refused by `handle_reservations`.
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
        UNION ALL SELECT 1 FROM handle_reservations WHERE skeleton = ?2 AND publisher != ?3
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

/**
 * Makes the account's profile; false when its handle or skeleton was taken first, or is one
 * another account retired: the insert reserves the skeleton in the same statement.
 */
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
    // The count includes the reservation the insert wrote.
    return result.meta.changes > 0;
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
 * Moves a publisher from the handle it was read with to a new one, in one statement that
 * re-checks that handle. The skeleton's reservation moves with it: the old one stays retired
 * for the account, so nobody else can take it, and taking back one of its own retired handles
 * un-retires it. `stale` when another rename landed first, `taken` when another account holds
 * the skeleton, active or retired.
 */
export async function changeHandle(
  db: D1Database,
  publisher: { id: string; name: string },
  next: { handle: string; skeleton: string },
): Promise<"moved" | "stale" | "taken"> {
  try {
    const result = await db
      .prepare("UPDATE publishers SET name = ?3, skeleton = ?4 WHERE id = ?1 AND name = ?2")
      .bind(publisher.id, publisher.name, next.handle, next.skeleton)
      .run();
    // The count includes the reservations the rename moved.
    return result.meta.changes > 0 ? "moved" : "stale";
  } catch (error) {
    if (isUniqueFailure(error)) return "taken";
    throw error;
  }
}

export async function setAvatar(db: D1Database, id: string, sha256: string): Promise<void> {
  await db.prepare("UPDATE publishers SET avatar = ?2 WHERE id = ?1").bind(id, sha256).run();
}

/* ---------------------------------------------------------------- pictures */

/** How long a picture nothing names is kept: an upload on its way names it well within this. */
export const pictureGraceMs = 24 * 3_600_000;

/**
 * Charges a picture's bytes to the publisher before they are written (ADR 0173 §9), in the one
 * statement that checks they fit beside its versions, drafts and other pictures. The same
 * picture again is charged once. In the same batch the row drops any claim the cron holds on
 * the key, so the cron won't delete bytes a row now holds. False when it doesn't fit, or while
 * the cron is deleting that very object (a retry a moment later goes through).
 */
export type PictureReservation = "stored" | "quota" | "deleting";

export async function reservePicture(
  db: D1Database,
  input: { publisher: string; key: string; size: number; quotaBytes: number; now: number },
): Promise<PictureReservation> {
  // storedBytesSql already counts every picture of the publisher; subtract this key's own stored
  // size (0 when it is new) so a replacement is charged only for its change.
  const fits = `${storedBytesSql("?2")}
      - (SELECT COALESCE(SUM(size), 0) FROM pictures WHERE publisher = ?2 AND key = ?1) + ?3 <= ?5
      AND NOT EXISTS (SELECT 1 FROM picture_tombstones WHERE key = ?1 AND deleting = 1)`;
  const [charged] = await db.batch([
    db
      .prepare(
        `INSERT INTO pictures (key, publisher, size, at) SELECT ?1, ?2, ?3, ?4 WHERE ${fits}
          ON CONFLICT (key, publisher) DO UPDATE SET size = excluded.size, at = excluded.at
            WHERE ${fits}`,
      )
      .bind(input.key, input.publisher, input.size, input.now, input.quotaBytes),
    db
      .prepare(
        `DELETE FROM picture_tombstones WHERE key = ?1 AND deleting = 0
          AND EXISTS (SELECT 1 FROM pictures WHERE key = ?1)`,
      )
      .bind(input.key),
  ]);
  if ((charged?.meta.changes ?? 0) > 0) return "stored";
  // The write didn't land: either it didn't fit the quota, or the cron is deleting this key now.
  const racing = await db
    .prepare("SELECT 1 AS found FROM picture_tombstones WHERE key = ?1 AND deleting = 1")
    .bind(input.key)
    .first<{ found: number }>();
  return racing ? "deleting" : "quota";
}

/**
 * Whether the picture row's publisher still shows it: its avatar as its own profile's, a
 * listing picture in any entry's listing or pending listing (a transferred entry keeps its
 * pictures).
 */
const pictureNamed = `(CASE WHEN substr(pictures.key, 1, 8) = 'avatars/'
    THEN EXISTS (SELECT 1 FROM publishers
      WHERE id = pictures.publisher AND avatar = substr(pictures.key, 9))
    ELSE EXISTS (SELECT 1 FROM entries
      WHERE instr(COALESCE(listing, ''), substr(pictures.key, 10)) > 0
        OR instr(COALESCE(pending_listing, ''), substr(pictures.key, 10)) > 0) END)`;

/**
 * Looks at up to `limit` picture rows older than the grace period: one nothing names is
 * dropped (its bytes stop counting), one still named is looked at again a grace period later.
 * One batch, each statement re-checking, so a profile or listing that names a picture on the
 * way keeps it.
 */
export async function sweepPictureRows(db: D1Database, now: number, limit: number) {
  const due = `rowid IN (SELECT rowid FROM pictures WHERE at < ?1 ORDER BY at LIMIT ?2)`;
  await db.batch([
    db
      .prepare(`DELETE FROM pictures WHERE ${due} AND NOT ${pictureNamed}`)
      .bind(now - pictureGraceMs, limit),
    db
      .prepare(`UPDATE pictures SET at = ?3 WHERE ${due} AND ${pictureNamed}`)
      .bind(now - pictureGraceMs, limit, now),
  ]);
}

/** How long a claim stands before the cron acts on it: at least one run apart. */
export const pictureClaimMs = 10 * 60_000;

const unheld = (key: string) => `NOT EXISTS (SELECT 1 FROM pictures WHERE pictures.key = ${key})`;

/**
 * The cron's first step on R2 objects it found past the grace period (ADR 0173 §1): each one no
 * picture row holds gets a claim, in one statement that checks. Nothing is deleted yet; an
 * upload that charges the key before the next step drops the claim.
 */
export async function claimPictures(db: D1Database, keys: readonly string[], now: number) {
  if (keys.length === 0) return;
  await db
    .prepare(
      `INSERT INTO picture_tombstones (key, claimed_at)
        SELECT value, ?2 FROM json_each(?1) WHERE ${unheld("value")}
        ON CONFLICT (key) DO NOTHING`,
    )
    .bind(JSON.stringify(keys), now)
    .run();
}

/**
 * The cron's second step: up to `limit` claims at least `pictureClaimMs` old whose key still no
 * row holds are marked deleting, in one statement that re-checks, and their keys returned for
 * the caller to delete from R2. A claim a row now holds is dropped, the object kept. A claim already marked
 * deleting (a run cut off before it finished) is returned again. While marked, uploads of the
 * key are refused, so no bytes land between this and the R2 delete.
 */
export async function startPictureDeletes(
  db: D1Database,
  now: number,
  limit: number,
): Promise<string[]> {
  const due = `key IN (SELECT key FROM picture_tombstones
    WHERE deleting = 1 OR claimed_at <= ?1 ORDER BY claimed_at LIMIT ?2)`;
  const [, marked] = await db.batch<{ key: string }>([
    db
      .prepare(
        `DELETE FROM picture_tombstones WHERE ${due} AND NOT ${unheld("picture_tombstones.key")}`,
      )
      .bind(now - pictureClaimMs, limit),
    db
      .prepare(
        `UPDATE picture_tombstones SET deleting = 1
          WHERE ${due} AND ${unheld("picture_tombstones.key")} RETURNING key`,
      )
      .bind(now - pictureClaimMs, limit),
  ]);
  return (marked?.results ?? []).map((row) => row.key);
}

/** Drops the claims of objects the cron has deleted from R2, which lets their uploads through. */
export async function finishPictureDeletes(db: D1Database, keys: readonly string[]) {
  if (keys.length === 0) return;
  await db
    .prepare(
      "DELETE FROM picture_tombstones WHERE deleting = 1 AND key IN (SELECT value FROM json_each(?1))",
    )
    .bind(JSON.stringify(keys))
    .run();
}

/** Where the cron's walk of an R2 prefix got to; undefined to start again. */
export async function sweepCursor(db: D1Database, prefix: string): Promise<string | undefined> {
  const row = await db
    .prepare("SELECT after FROM sweep_cursors WHERE prefix = ?1")
    .bind(prefix)
    .first<{ after: string }>();
  return row?.after;
}

export async function setSweepCursor(db: D1Database, prefix: string, after: string | undefined) {
  await (
    after === undefined
      ? db.prepare("DELETE FROM sweep_cursors WHERE prefix = ?1").bind(prefix)
      : db
          .prepare(
            `INSERT INTO sweep_cursors (prefix, after) VALUES (?1, ?2)
            ON CONFLICT (prefix) DO UPDATE SET after = excluded.after`,
          )
          .bind(prefix, after)
  ).run();
}

/**
 * Sets the publisher's pins in one statement that re-checks every pinned entry is still theirs
 * and listed; false when one moved or left the index on the way.
 */
export async function setPins(
  db: D1Database,
  id: string,
  pins: readonly MarketEntryRef[],
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE publishers SET pins = ?2 WHERE id = ?1
        AND (SELECT COUNT(*) FROM entries WHERE publisher = ?1 AND listed = 1
          AND (type || '/' || name) IN (SELECT value FROM json_each(?3))) = ?4`,
    )
    .bind(
      id,
      JSON.stringify(pins),
      JSON.stringify(pins.map((pin) => `${pin.type}/${pin.name}`)),
      pins.length,
    )
    .run();
  return result.meta.changes === 1;
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
