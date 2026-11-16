import type { ScanState } from "@ace/marketplace/scan";
import type {
  MarketDraft,
  MarketEntryType,
  MarketProblem,
  MarketScanReport,
} from "@ace/protocol/marketplace";
import { draftKey, draftReportKey } from "../context.ts";
import { getReport } from "./me-scan.ts";

/*
 * Drafts (ADR 0173 §5): the archive at `drafts/<id>`, its scan report at
 * `reports/drafts/<id>.json`, and a scan that didn't fit one request in `scan_jobs`.
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

/** The draft's row written new or over itself, with its scan done or carried on as a job. */
export async function writeDraft(
  db: D1Database,
  draft: DraftWrite,
  scan: { done: true; verdict: string } | { done: false; job: ScanJob },
): Promise<void> {
  const statements = [
    db
      .prepare(
        `INSERT INTO drafts (id, publisher, type, name, version, hash, size, files, title,
            problems, scan_state, verdict, created, updated)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
          ON CONFLICT (id) DO UPDATE SET version = excluded.version, hash = excluded.hash,
            size = excluded.size, files = excluded.files, title = excluded.title,
            problems = excluded.problems, scan_state = excluded.scan_state,
            verdict = excluded.verdict, updated = excluded.updated`,
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
      ),
    scan.done
      ? db.prepare("DELETE FROM scan_jobs WHERE draft = ?1").bind(draft.id)
      : jobStatement(db, draft.id, scan.job, draft.now),
  ];
  await db.batch(statements);
}

const jobStatement = (db: D1Database, draft: string, job: ScanJob, now: number) =>
  db
    .prepare(
      `INSERT INTO scan_jobs (draft, cursor, files, state, updated) VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT (draft) DO UPDATE SET cursor = excluded.cursor, files = excluded.files,
          state = excluded.state, updated = excluded.updated`,
    )
    .bind(draft, job.cursor, job.files, JSON.stringify(job.state), now);

/** A scan job moved one step on; when done, the draft takes its verdict. */
export async function advanceJob(
  db: D1Database,
  draft: string,
  next: { done: true; verdict: string } | { done: false; job: ScanJob },
  now: number,
): Promise<void> {
  if (!next.done) {
    await jobStatement(db, draft, next.job, now).run();
    return;
  }
  await db.batch([
    db.prepare("DELETE FROM scan_jobs WHERE draft = ?1").bind(draft),
    db
      .prepare("UPDATE drafts SET scan_state = 'done', verdict = ?2 WHERE id = ?1")
      .bind(draft, next.verdict),
  ]);
}

export async function patchDraft(
  db: D1Database,
  id: string,
  fields: { version?: string | undefined; changelog?: string | undefined },
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE drafts SET version = COALESCE(?2, version), changelog = COALESCE(?3, changelog),
        updated = ?4 WHERE id = ?1`,
    )
    .bind(id, fields.version ?? null, fields.changelog ?? null, now)
    .run();
}

/** The draft, its job, its bytes and its report, gone. */
export async function deleteDraft(db: D1Database, bucket: R2Bucket, id: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM scan_jobs WHERE draft = ?1").bind(id),
    db.prepare("DELETE FROM drafts WHERE id = ?1").bind(id),
  ]);
  await bucket.delete([draftKey(id), draftReportKey(id)]);
}

/** The draft as its publisher sees it, with its scan's report when done. */
export async function draftBody(
  bucket: R2Bucket,
  db: D1Database,
  row: DraftTable,
): Promise<MarketDraft> {
  let scan: MarketDraft["scan"];
  const report: MarketScanReport | undefined =
    row.scan_state === "done" ? await getReport(bucket, draftReportKey(row.id)) : undefined;
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
