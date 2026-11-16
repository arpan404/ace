import type { z } from "zod";
import type { MarketLimits as Schema } from "@ace/protocol/marketplace";
import { dayOf, publisherLimits } from "../rules.ts";

export type MarketLimits = z.infer<typeof Schema>;

/*
 * A publisher's limits (ADR 0173 §9): uploads a day, bytes stored in versions and drafts, and
 * drafts. Publishers are accounts, so counting them tracks no reader.
 */

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
        (SELECT COALESCE(SUM(size), 0) FROM drafts WHERE publisher = ?1) +
        (SELECT COALESCE(SUM(v.size), 0) FROM versions v JOIN entries e
          ON e.type = v.type AND e.name = v.name
          WHERE e.publisher = ?1 AND v.state != 'blocked') AS stored,
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

export async function countUpload(db: D1Database, publisher: string, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO upload_days (publisher, day, count) VALUES (?1, ?2, 1)
        ON CONFLICT (publisher, day) DO UPDATE SET count = count + 1`,
    )
    .bind(publisher, dayOf(now))
    .run();
}
