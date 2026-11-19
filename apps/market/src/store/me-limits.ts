import type { z } from "zod";
import type { MarketLimits as Schema } from "@ace/protocol/marketplace";
import { dayOf, publisherLimits, type LimitTier } from "../rules.ts";

export type MarketLimits = z.infer<typeof Schema>;
export type Caps = ReturnType<typeof publisherLimits>;

/*
 * A publisher's limits (ADR 0174 §9), in the publishers database: uploads a day, bytes stored in
 * versions, drafts and pictures, and drafts. Publishers are accounts, so counting them tracks no
 * reader. Each limit is checked in the statement that uses it up, never read first and written
 * after, so concurrent uploads can't all take the last slot. Versions live in their type's
 * catalogue, so their bytes are counted through the quota ledger (`charges`, ADR 0174 §16): a
 * charge is written before its version, here, and only the cron's reconcile drops or corrects
 * one (`store/usage.ts`).
 */

/**
 * The bytes the publisher at parameter `publisher` stores: drafts (except one claimed for a
 * publish, whose bytes are on its version's charge), charged versions and pictures.
 */
export const storedBytesSql = (publisher: string) =>
  `((SELECT COALESCE(SUM(size), 0) FROM drafts
      WHERE publisher = ${publisher} AND publishing IS NULL) +
    (SELECT COALESCE(SUM(size), 0) FROM charges WHERE publisher = ${publisher}) +
    (SELECT COALESCE(SUM(size), 0) FROM pictures WHERE publisher = ${publisher}))`;

/** A version's key in the quota ledger. */
export const chargeItem = (key: { type: string; name: string; version: string }) =>
  `${key.type}/${key.name}/${key.version}`;

/** Marks the publisher's charges for the cron's reconcile. */
export const markUsageDirty = (db: D1Database, publisher: string, now: number) =>
  db
    .prepare("UPDATE publishers SET usage_dirty = COALESCE(usage_dirty, ?2) WHERE id = ?1")
    .bind(publisher, now);

export async function limitsOf(
  db: D1Database,
  publisher: string,
  tier: LimitTier,
  now: number,
): Promise<MarketLimits> {
  const row = await db
    .prepare(
      `SELECT
        (SELECT COALESCE(SUM(count), 0) FROM upload_days WHERE publisher = ?1 AND day = ?2) AS uploads,
        ${storedBytesSql("?1")} AS stored,
        (SELECT COUNT(*) FROM drafts WHERE publisher = ?1) AS drafts`,
    )
    .bind(publisher, dayOf(now))
    .first<{ uploads: number; stored: number; drafts: number }>();
  const caps = publisherLimits(tier);
  return {
    uploadsToday: row?.uploads ?? 0,
    uploadsPerDay: caps.uploadsPerDay,
    storedBytes: row?.stored ?? 0,
    quotaBytes: caps.quotaBytes,
    drafts: row?.drafts ?? 0,
    draftLimit: caps.draftLimit,
  };
}

/** Why one more upload of `size` bytes is refused, or undefined when it fits. */
export function uploadRefusal(
  limits: MarketLimits,
  size: number,
  options: { newDraft: boolean },
): string | undefined {
  if (limits.uploadsToday >= limits.uploadsPerDay)
    return `You can upload ${limits.uploadsPerDay} times a day; try again tomorrow.`;
  if (limits.storedBytes + size > limits.quotaBytes)
    return `Your entries and drafts can take ${Math.round(limits.quotaBytes / 1024 / 1024)} MB.`;
  if (options.newDraft && limits.drafts >= limits.draftLimit)
    return `You can keep ${limits.draftLimit} drafts; publish or delete one first.`;
  return undefined;
}

export interface UploadReservation {
  publisher: string;
  tier: LimitTier;
  size: number;
  /** Whether the upload makes a new draft, so the draft cap applies. */
  newDraft: boolean;
  /** The draft it replaces, whose bytes no longer count. */
  replacing?: string | undefined;
  /**
   * A version stored straight from the upload: its bytes are charged to it in the statement
   * that counts the upload. `nonce` is this request's own, to tell its charge apart.
   */
  charge?: { item: string; nonce: string } | undefined;
  now: number;
}

/**
 * Counts one upload against today's limit, only if it fits: under the daily count, within the
 * stored bytes and, for a new draft, under the draft cap, all in the one statement that counts
 * it. Answers why it doesn't fit, or undefined when it was counted.
 */
export async function reserveUpload(
  db: D1Database,
  input: UploadReservation,
): Promise<string | undefined> {
  const caps = publisherLimits(input.tier);
  const values = [
    input.publisher,
    dayOf(input.now),
    caps.uploadsPerDay,
    input.size,
    caps.quotaBytes,
    input.newDraft ? 1 : 0,
    caps.draftLimit,
    input.replacing ?? "",
    input.charge?.item ?? "",
    input.charge?.nonce ?? "",
    input.now,
  ];
  const result = input.charge
    ? await chargeVersion(db, values)
    : await db
        .prepare(
          `INSERT INTO upload_days (publisher, day, count) SELECT ?1, ?2, 1 WHERE ?3 > 0 AND ${draftFits}
            ON CONFLICT (publisher, day) DO UPDATE SET count = count + 1
              WHERE upload_days.count < ?3 AND ${draftFits}`,
        )
        .bind(...values.slice(0, 8))
        .run();
  if (result.meta.changes === 1) return undefined;
  const limits = await limitsOf(db, input.publisher, input.tier, input.now);
  const replaced = input.replacing
    ? ((await db
        .prepare("SELECT size FROM drafts WHERE id = ?1")
        .bind(input.replacing)
        .first<{ size: number }>()) ?? { size: 0 })
    : { size: 0 };
  return (
    uploadRefusal({ ...limits, storedBytes: limits.storedBytes - replaced.size }, input.size, {
      newDraft: input.newDraft,
    }) ?? quotaRace
  );
}

/** Fits as a draft (`?8` the draft replaced, `?6` whether it is new). */
const draftFits = `${storedBytesSql("?1")}
      - COALESCE((SELECT size FROM drafts WHERE id = ?8 AND publisher = ?1 AND publishing IS NULL), 0)
      + ?4 <= ?5
    AND (?6 = 0 OR (SELECT COUNT(*) FROM drafts WHERE publisher = ?1) < ?7)`;

/**
 * Charges version `?9` and counts the upload in one batch: the charge is written (or raised) only
 * under today's count and within the quota, counting the charge's own earlier size once; the
 * count follows only when this request's charge (`?10`) stands. The publisher is marked for the
 * reconcile, which drops a charge whose version never got stored.
 */
async function chargeVersion(db: D1Database, values: readonly (string | number)[]) {
  const fits = `COALESCE((SELECT count FROM upload_days WHERE publisher = ?1 AND day = ?2), 0) < ?3
    AND ${storedBytesSql("?1")} - COALESCE((SELECT size FROM charges WHERE item = ?9), 0) + ?4 <= ?5`;
  const [, counted] = await db.batch([
    db
      .prepare(
        `INSERT INTO charges (item, publisher, size, at, nonce) SELECT ?9, ?1, ?4, ?11, ?10
          WHERE ${fits}
          ON CONFLICT (item) DO UPDATE SET publisher = excluded.publisher,
            size = MAX(charges.size, excluded.size), at = excluded.at, nonce = excluded.nonce
            WHERE ${fits}`,
      )
      .bind(...values),
    db
      .prepare(
        `INSERT INTO upload_days (publisher, day, count)
          SELECT ?1, ?2, 1 WHERE EXISTS (SELECT 1 FROM charges WHERE item = ?9 AND nonce = ?10)
          ON CONFLICT (publisher, day) DO UPDATE SET count = count + 1`,
      )
      .bind(...values.slice(0, 10)),
    db
      .prepare(
        `UPDATE publishers SET usage_dirty = COALESCE(usage_dirty, ?11) WHERE id = ?1
          AND EXISTS (SELECT 1 FROM charges WHERE item = ?9 AND nonce = ?10)`,
      )
      .bind(...values),
  ]);
  return { meta: { changes: counted?.meta.changes ?? 0 } };
}

/** A limit another upload reached at the same moment. */
export const quotaRace = "You're at one of your upload limits; check your drafts and try again.";
