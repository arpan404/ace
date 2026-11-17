import type { ScanState } from "@ace/marketplace/scan";
import type {
  MarketDraft,
  MarketEntryType,
  MarketProblem,
  MarketScanReport,
} from "@ace/protocol/marketplace";
import { draftKey, draftPrefix, draftReportKey, draftReportPrefix } from "../context.ts";
import { storedBytesSql } from "./me-limits.ts";
import { getReport } from "./me-scan.ts";

/*
 * Drafts (ADR 0173 §5), in the publishers database: the archive at `drafts/<id>/<hash>`, its
 * scan report at `reports/drafts/<id>/<hash>.json`, and a scan that didn't fit one request in
 * `scan_jobs`. The bytes are keyed by the hash the row names, so the row never points at another
 * revision's. Publishing claims the draft first (`claimDraft`, ADR 0173 §16): a claimed draft
 * isn't replaced, edited or deleted until the publish finishes or is released.
 */

export interface DraftTable {
  id: string;
  publisher: string;
  type: MarketEntryType;
  name: string;
  version: string;
  hash: string;
  size: number;
  files: number;
  title: string;
  changelog: string;
  problems: string;
  scan_state: "scanning" | "done";
  verdict: string | null;
  created: number;
  updated: number;
  /** The version (`type/name/version`) a publish claimed this draft for. */
  publishing: string | null;
  publishing_at: number | null;
}

export interface ScanJob {
  cursor: number;
  files: number;
  state: ScanState;
}

export async function readDraft(db: D1Database, id: string): Promise<DraftTable | undefined> {
  return (
    (await db.prepare("SELECT * FROM drafts WHERE id = ?1").bind(id).first<DraftTable>()) ??
    undefined
  );
}

export async function draftsOf(db: D1Database, publisher: string): Promise<DraftTable[]> {
  const { results } = await db
    .prepare("SELECT * FROM drafts WHERE publisher = ?1 ORDER BY updated DESC LIMIT 20")
    .bind(publisher)
    .all<DraftTable>();
  return results;
}

export async function scanJob(db: D1Database, draft: string): Promise<ScanJob | undefined> {
  const row = await db
    .prepare("SELECT cursor, files, state FROM scan_jobs WHERE draft = ?1")
    .bind(draft)
    .first<{ cursor: number; files: number; state: string }>();
  return row
    ? { cursor: row.cursor, files: row.files, state: JSON.parse(row.state) as ScanState }
    : undefined;
}

export interface DraftWrite {
  id: string;
  publisher: string;
  type: MarketEntryType;
  name: string;
  version: string;
  hash: string;
  size: number;
  files: number;
  title: string;
  problems: readonly MarketProblem[];
  now: number;
}

/**
 * The draft's row written new or over itself, with its scan done or carried on as a job, only if
 * it fits the publisher's limits in the same statement: a new draft under the draft cap, and the
 * bytes within the quota counting this draft's new size instead of its old. False when it
 * doesn't fit (another upload took the room) or the draft is someone else's.
 */
export async function writeDraft(
  db: D1Database,
  draft: DraftWrite,
  scan: { done: true; verdict: string } | { done: false; job: ScanJob },
  caps: { quotaBytes: number; draftLimit: number },
): Promise<boolean> {
  const stored = storedBytesSql("?2");
  const [written] = await db.batch([
    db
      .prepare(
        `INSERT INTO drafts (id, publisher, type, name, version, hash, size, files, title,
            problems, scan_state, verdict, created, updated)
          SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13
            WHERE EXISTS (SELECT 1 FROM drafts WHERE id = ?1)
            OR ((SELECT COUNT(*) FROM drafts WHERE publisher = ?2) < ?15
              AND ${stored} + ?7 <= ?14)
          ON CONFLICT (id) DO UPDATE SET version = excluded.version, hash = excluded.hash,
            size = excluded.size, files = excluded.files, title = excluded.title,
            problems = excluded.problems, scan_state = excluded.scan_state,
            verdict = excluded.verdict, updated = excluded.updated
          WHERE drafts.publisher = excluded.publisher AND drafts.publishing IS NULL
            AND ${stored} - drafts.size + excluded.size <= ?14`,
      )
      .bind(
        draft.id,
        draft.publisher,
        draft.type,
        draft.name,
        draft.version,
        draft.hash,
        draft.size,
        draft.files,
        draft.title.slice(0, 120) || draft.name,
        JSON.stringify(draft.problems.slice(0, 200)),
        scan.done ? "done" : "scanning",
        scan.done ? scan.verdict : null,
        draft.now,
        caps.quotaBytes,
        caps.draftLimit,
      ),
    scan.done
      ? db
          .prepare(
            `DELETE FROM scan_jobs WHERE draft = ?1
              AND EXISTS (SELECT 1 FROM drafts WHERE id = ?1 AND hash = ?2 AND updated = ?3)`,
          )
          .bind(draft.id, draft.hash, draft.now)
      : jobStatement(db, draft.id, draft.hash, scan.job, draft.now),
  ]);
  return (written?.meta.changes ?? 0) === 1;
}

/** The draft's scan job, written only while the draft still holds the bytes `hash` names. */
const jobStatement = (db: D1Database, draft: string, hash: string, job: ScanJob, now: number) =>
  db
    .prepare(
      `INSERT INTO scan_jobs (draft, cursor, files, state, updated)
        SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM drafts WHERE id = ?1 AND hash = ?6)
        ON CONFLICT (draft) DO UPDATE SET cursor = excluded.cursor, files = excluded.files,
          state = excluded.state, updated = excluded.updated`,
    )
    .bind(draft, job.cursor, job.files, JSON.stringify(job.state), now, hash);

/**
 * A scan job moved one step on over the bytes `hash` names; when done, the draft takes its
 * verdict. False when the draft was replaced meanwhile, so the step read other bytes.
 */
export async function advanceJob(
  db: D1Database,
  draft: string,
  hash: string,
  next: { done: true; verdict: string } | { done: false; job: ScanJob },
  now: number,
): Promise<boolean> {
  if (!next.done) {
    const result = await jobStatement(db, draft, hash, next.job, now).run();
    return result.meta.changes === 1;
  }
  const [, done] = await db.batch([
    db
      .prepare(
        `DELETE FROM scan_jobs WHERE draft = ?1
          AND EXISTS (SELECT 1 FROM drafts WHERE id = ?1 AND hash = ?2)`,
      )
      .bind(draft, hash),
    db
      .prepare("UPDATE drafts SET scan_state = 'done', verdict = ?3 WHERE id = ?1 AND hash = ?2")
      .bind(draft, hash, next.verdict),
  ]);
  return (done?.meta.changes ?? 0) === 1;
}

/** Moves a job that read bytes its draft no longer names to the back of the cron's queue. */
export async function deferJob(db: D1Database, draft: string, now: number): Promise<void> {
  await db.prepare("UPDATE scan_jobs SET updated = ?2 WHERE draft = ?1").bind(draft, now).run();
}

/** Changes a draft's version or changelog; false while a publish has claimed it. */
export async function patchDraft(
  db: D1Database,
  id: string,
  fields: { version?: string | undefined; changelog?: string | undefined },
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE drafts SET version = COALESCE(?2, version), changelog = COALESCE(?3, changelog),
        updated = ?4 WHERE id = ?1 AND publishing IS NULL`,
    )
    .bind(id, fields.version ?? null, fields.changelog ?? null, now)
    .run();
  return result.meta.changes === 1;
}

/**
 * Claims the draft for publishing `item` (ADR 0173 §16): only while it still holds `hash` with
 * its scan done, and not claimed for another version. In the same batch its bytes move onto the
 * version's charge, so they count once, and the publisher is marked for the quota reconcile.
 * Claiming again for the same version is fine: that is how a cut-off publish resumes.
 */
export async function claimDraft(
  db: D1Database,
  draft: { id: string; hash: string; publisher: string },
  item: string,
  now: number,
): Promise<boolean> {
  const [claimed] = await db.batch([
    db
      .prepare(
        `UPDATE drafts SET publishing = ?4, publishing_at = COALESCE(publishing_at, ?5)
          WHERE id = ?1 AND hash = ?2 AND publisher = ?3 AND scan_state = 'done'
            AND (publishing IS NULL OR publishing = ?4)`,
      )
      .bind(draft.id, draft.hash, draft.publisher, item, now),
    db
      .prepare(
        `INSERT INTO charges (item, publisher, size, at)
          SELECT ?3, publisher, size, ?4 FROM drafts WHERE id = ?1 AND hash = ?2 AND publishing = ?3
          ON CONFLICT (item) DO UPDATE SET publisher = excluded.publisher,
            size = MAX(charges.size, excluded.size), at = excluded.at`,
      )
      .bind(draft.id, draft.hash, item, now),
    db
      .prepare("UPDATE publishers SET usage_dirty = COALESCE(usage_dirty, ?2) WHERE id = ?1")
      .bind(draft.publisher, now),
  ]);
  return (claimed?.meta.changes ?? 0) === 1;
}

/** Gives a claimed draft back: its publish stored nothing. Its version's charge is reconciled. */
export async function releaseDraft(db: D1Database, id: string, item: string): Promise<void> {
  await db
    .prepare(
      "UPDATE drafts SET publishing = NULL, publishing_at = NULL WHERE id = ?1 AND publishing = ?2",
    )
    .bind(id, item)
    .run();
}

/** Claims older than `before`: publishes cut off part way, for the cron to finish or release. */
export async function staleClaims(db: D1Database, before: number, limit: number) {
  const { results } = await db
    .prepare(
      `SELECT * FROM drafts WHERE publishing IS NOT NULL AND publishing_at < ?1
        ORDER BY publishing_at LIMIT ?2`,
    )
    .bind(before, limit)
    .all<DraftTable>();
  return results;
}

/** A published draft gone, only if it still holds the bytes that were published. */
export async function deletePublishedDraft(
  db: D1Database,
  bucket: R2Bucket,
  id: string,
  hash: string,
): Promise<void> {
  const [, gone] = await db.batch([
    db
      .prepare(
        `DELETE FROM scan_jobs WHERE draft = ?1
          AND EXISTS (SELECT 1 FROM drafts WHERE id = ?1 AND hash = ?2)`,
      )
      .bind(id, hash),
    db.prepare("DELETE FROM drafts WHERE id = ?1 AND hash = ?2").bind(id, hash),
  ]);
  if ((gone?.meta.changes ?? 0) === 1) await removeDraftRevisions(db, bucket, id);
}

/**
 * Deletes a draft's revisions in R2 that its row doesn't name (all of them once the row is
 * gone). The keys are listed before the row is read: a revision put after the listing isn't
 * touched, and one listed was put after its row was written, so a row read later that names
 * another hash has moved on from it.
 */
export async function removeDraftRevisions(
  db: D1Database,
  bucket: R2Bucket,
  id: string,
): Promise<void> {
  const listed = await Promise.all(
    [draftPrefix(id), draftReportPrefix(id)].map((prefix) => bucket.list({ prefix })),
  );
  const row = await db
    .prepare("SELECT hash FROM drafts WHERE id = ?1")
    .bind(id)
    .first<{ hash: string }>();
  const keep = row ? new Set([draftKey(id, row.hash), draftReportKey(id, row.hash)]) : new Set();
  const stale = listed
    .flatMap((list) => list.objects.map((object) => object.key))
    .filter((key) => !keep.has(key));
  if (stale.length > 0) await bucket.delete(stale);
}

/** The draft, its job, its bytes and its report, gone; false while a publish has claimed it. */
export async function deleteDraft(db: D1Database, bucket: R2Bucket, id: string): Promise<boolean> {
  const unclaimed = "EXISTS (SELECT 1 FROM drafts WHERE id = ?1 AND publishing IS NULL)";
  const [, gone] = await db.batch([
    db.prepare(`DELETE FROM scan_jobs WHERE draft = ?1 AND ${unclaimed}`).bind(id),
    db.prepare("DELETE FROM drafts WHERE id = ?1 AND publishing IS NULL").bind(id),
  ]);
  if ((gone?.meta.changes ?? 0) !== 1) return false;
  await removeDraftRevisions(db, bucket, id);
  return true;
}

/** The draft as its publisher sees it, with its scan's report when done. */
export async function draftBody(
  bucket: R2Bucket,
  db: D1Database,
  row: DraftTable,
): Promise<MarketDraft> {
  let scan: MarketDraft["scan"];
  const report: MarketScanReport | undefined =
    row.scan_state === "done"
      ? await getReport(bucket, draftReportKey(row.id, row.hash))
      : undefined;
  if (report) scan = { state: "done", report };
  else {
    const job = await scanJob(db, row.id);
    scan = { state: "scanning", read: job?.cursor ?? 0, files: row.files };
  }
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    version: row.version,
    hash: row.hash || "0".repeat(64),
    size: row.size,
    files: row.files,
    created: row.created,
    updated: row.updated,
    changelog: row.changelog,
    title: row.title || row.name,
    problems: JSON.parse(row.problems) as MarketProblem[],
    scan,
  };
}
