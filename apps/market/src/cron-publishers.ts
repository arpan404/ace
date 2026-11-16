import { skeleton } from "@ace/marketplace/profile";
import { continueDraftScan } from "./api-publish.ts";
import type { Env } from "./env.ts";
import { deleteDraft, type DraftTable } from "./store/drafts.ts";
import { dueRechecks, recordRecheck } from "./store/verification.ts";
import { checkDomain, type ProofFetch } from "./verify-proofs.ts";

/*
 * The publishers' cron steps (ADR 0173 §5, §8, §13), each bounded: scan jobs that didn't fit a
 * request, drafts untouched for 30 days (with their bytes), expired transfers and proof tokens,
 * weekly domain re-checks that flag a mark and never drop it, and handle skeletons for rows from
 * before the migration.
 */

const day = 86_400_000;
export const draftDays = 30;
const batch = { scans: 5, drafts: 100, skeletons: 200, rechecks: 20 } as const;

export async function publisherCron(env: Env, now: number, fetch: ProofFetch): Promise<void> {
  await scanJobs(env, now);
  await staleDrafts(env, now);
  await expire(env.MARKET, now);
  await rechecks(env.MARKET, now, fetch);
  await fillSkeletons(env.MARKET);
}

async function scanJobs(env: Env, now: number) {
  const { results } = await env.MARKET.prepare(
    `SELECT d.*, p.name AS handle,
        EXISTS (SELECT 1 FROM official_accounts o WHERE o.publisher = p.id) AS official
      FROM scan_jobs j JOIN drafts d ON d.id = j.draft JOIN publishers p ON p.id = d.publisher
      ORDER BY j.updated LIMIT ?1`,
  )
    .bind(batch.scans)
    .all<DraftTable & { handle: string; official: number }>();
  for (const draft of results)
    await continueDraftScan(
      env,
      draft,
      { handle: draft.handle, official: draft.official === 1 },
      now,
    );
}

async function staleDrafts(env: Env, now: number) {
  const { results } = await env.MARKET.prepare(
    "SELECT id FROM drafts WHERE updated < ?1 ORDER BY updated LIMIT ?2",
  )
    .bind(now - draftDays * day, batch.drafts)
    .all<{ id: string }>();
  for (const draft of results) await deleteDraft(env.MARKET, env.OBJECTS, draft.id);
}

async function expire(db: D1Database, now: number) {
  await db.batch([
    db.prepare("DELETE FROM transfers WHERE expires <= ?1").bind(now),
    // A passed token stays: the weekly re-check reads it again.
    db
      .prepare("DELETE FROM verification_challenges WHERE state != 'passed' AND expires <= ?1")
      .bind(now),
  ]);
}

async function rechecks(db: D1Database, now: number, fetch: ProofFetch) {
  for (const due of await dueRechecks(db, now, batch.rechecks)) {
    const outcome = await checkDomain(due.domain, due.token, fetch);
    await recordRecheck(
      db,
      due.publisher,
      "problem" in outcome
        ? `The weekly re-check failed: ${outcome.problem}`.slice(0, 500)
        : undefined,
      now,
    );
  }
}

async function fillSkeletons(db: D1Database) {
  const { results } = await db
    .prepare("SELECT id, name FROM publishers WHERE skeleton IS NULL LIMIT ?1")
    .bind(batch.skeletons)
    .all<{ id: string; name: string }>();
  for (const row of results) {
    try {
      await db
        .prepare("UPDATE publishers SET skeleton = ?2 WHERE id = ?1")
        .bind(row.id, skeleton(row.name))
        .run();
    } catch (error) {
      // Two old handles with one skeleton: the later keeps its own name as its skeleton, so
      // the cron moves on; maintainers see both.
      if (!(error instanceof Error && /UNIQUE/i.test(error.message))) throw error;
      await db
        .prepare("UPDATE publishers SET skeleton = ?2 WHERE id = ?1")
        .bind(row.id, `${skeleton(row.name)}~${row.id}`)
        .run();
    }
  }
}
