import type { z } from "zod";
import type { MarketLimits as Schema } from "@ace/protocol/marketplace";
import { dayOf, publisherLimits } from "../rules.ts";

export type MarketLimits = z.infer<typeof Schema>;
export type Caps = ReturnType<typeof publisherLimits>;

/*
 * A publisher's limits (ADR 0173 §9): uploads a day, bytes stored in versions and drafts, and
 * drafts. Publishers are accounts, so counting them tracks no reader. Each limit is checked in
 * the statement that uses it up, never read first and written after, so concurrent uploads
 * can't all take the last slot.
 */

/** The bytes the publisher at parameter `publisher` stores: drafts and versions not blocked. */
export const storedBytesSql = (publisher: string) =>
  `((SELECT COALESCE(SUM(size), 0) FROM drafts WHERE publisher = ${publisher}) +
    (SELECT COALESCE(SUM(v.size), 0) FROM versions v JOIN entries e
      ON e.type = v.type AND e.name = v.name
      WHERE e.publisher = ${publisher} AND v.state != 'blocked') +
    (SELECT COALESCE(SUM(size), 0) FROM pictures WHERE publisher = ${publisher}))`;

export async function limitsOf(
  db: D1Database,
  publisher: string,
  newPublisher: boolean,
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
  const caps = publisherLimits(newPublisher);
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
  newPublisher: boolean;
  size: number;
  /** Whether the upload makes a new draft, so the draft cap applies. */
  newDraft: boolean;
  /** The draft it replaces, whose bytes no longer count. */
  replacing?: string | undefined;
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
  const caps = publisherLimits(input.newPublisher);
  const fits = `${storedBytesSql("?1")}
      - COALESCE((SELECT size FROM drafts WHERE id = ?8 AND publisher = ?1), 0) + ?4 <= ?5
    AND (?6 = 0 OR (SELECT COUNT(*) FROM drafts WHERE publisher = ?1) < ?7)`;
  const result = await db
    .prepare(
      `INSERT INTO upload_days (publisher, day, count) SELECT ?1, ?2, 1 WHERE ?3 > 0 AND ${fits}
        ON CONFLICT (publisher, day) DO UPDATE SET count = count + 1
          WHERE upload_days.count < ?3 AND ${fits}`,
    )
    .bind(
      input.publisher,
      dayOf(input.now),
      caps.uploadsPerDay,
      input.size,
      caps.quotaBytes,
      input.newDraft ? 1 : 0,
      caps.draftLimit,
      input.replacing ?? "",
    )
    .run();
  if (result.meta.changes === 1) return undefined;
  const limits = await limitsOf(db, input.publisher, input.newPublisher, input.now);
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

/** A limit another upload reached at the same moment. */
export const quotaRace = "You're at one of your upload limits; check your drafts and try again.";
