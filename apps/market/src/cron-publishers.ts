import { skeleton } from "@ace/marketplace/profile";
import { continueDraftScan } from "./api-publish.ts";
import type { Env } from "./env.ts";
import { syncDue } from "./store/copies.ts";
import { eachCatalogue, type Databases } from "./store/databases.ts";
import {
  deleteDraft,
  deletePublishedDraft,
  releaseDraft,
  staleClaims,
  type DraftTable,
} from "./store/drafts.ts";
import { chargeItem, markUsageDirty } from "./store/me-limits.ts";
import {
  claimPictures,
  finishPictureDeletes,
  heldPictureDeletes,
  pictureGraceMs,
  setSweepCursor,
  startPictureDeletes,
  sweepCursor,
  sweepPictureRows,
} from "./store/profiles.ts";
import { storedVersion } from "./store/publish.ts";
import { applyWithdrawnDue } from "./store/signer.ts";
import { recordSizes } from "./store/sizes.ts";
import { chargeGraceMs, reconcileDue } from "./store/usage.ts";
import { dueRechecks, recordRecheck } from "./store/verification.ts";
import { checkDomain, type ProofFetch } from "./verify-proofs.ts";

/*
 * The publishers' cron steps (ADR 0174 §5, §8, §13, §16), each bounded: the cross-database
 * protocols' resumption first (publisher copies behind, publishes cut off after claiming their
 * draft, catalogues behind the withdrawn list, the quota ledger's reconcile), then scan jobs that
 * didn't fit a request, drafts untouched for 30 days (with their bytes), expired transfers and
 * proof tokens, weekly domain re-checks that flag a mark and never drop it, handle skeletons for
 * rows without one, pictures nothing names past a grace period, and the daily size record.
 */

const day = 86_400_000;
export const draftDays = 30;
const batch = {
  scans: 5,
  drafts: 100,
  skeletons: 200,
  rechecks: 20,
  pictureRows: 200,
  pictureObjects: 200,
  copies: { publishers: 50, entries: 500 },
  claims: 20,
  usageMarked: 20,
  usageSweep: 5,
  usageVersions: 2_000,
} as const;
const picturePrefixes = ["avatars/", "previews/"] as const;

export async function publisherCron(
  env: Env,
  dbs: Databases,
  now: number,
  fetch: ProofFetch,
  owner: string,
): Promise<void> {
  await syncDue(dbs, now, batch.copies);
  await resumeClaims(dbs, env.OBJECTS, now);
  await applyWithdrawnDue(dbs, now);
  await reconcileDue(dbs, now, {
    marked: batch.usageMarked,
    sweep: batch.usageSweep,
    versions: batch.usageVersions,
  });
  await scanJobs(env, dbs, now);
  await staleDrafts(env, dbs, now);
  await expire(dbs, now);
  await rechecks(dbs.publishers, now, fetch);
  await fillSkeletons(dbs.publishers);
  await sweepPictures({ dbs, OBJECTS: env.OBJECTS }, now, owner);
  await recordSizes(dbs, now);
}

/**
 * Publishes cut off after claiming their draft (ADR 0174 §16): a claim older than the charge
 * grace whose version its catalogue stored with the draft's bytes is finished (the draft goes);
 * any other is released, so the draft can be published again. Either way the publisher's
 * charges are reconciled.
 */
export async function resumeClaims(dbs: Databases, bucket: R2Bucket, now: number) {
  for (const draft of await staleClaims(dbs.publishers, now - chargeGraceMs, batch.claims)) {
    const key = { type: draft.type, name: draft.name, version: draft.version };
    const catalogue = dbs.catalogue(draft.type);
    const stored = catalogue ? await storedVersion(catalogue, key) : undefined;
    if (stored?.hash === draft.hash)
      await deletePublishedDraft(dbs.publishers, bucket, draft.id, draft.hash);
    else await releaseDraft(dbs.publishers, draft.id, chargeItem(key));
    await markUsageDirty(dbs.publishers, draft.publisher, now).run();
  }
}

/**
 * Pictures nothing names (ADR 0174 §1): rows past the grace period that no profile or listing
 * names are dropped; objects claimed on an earlier run that still no row holds are deleted
 * under their claim; then one page of each R2 prefix is walked and objects past the grace
 * period that no row holds are claimed for a later run. An upload writes its row, dropping any
 * claim, before its bytes and names them after, so a cut-off one leaves only what this collects
 * and one that charges a claimed key keeps it.
 *
 * `owner` is this run's own id. A run takes a claim only while no other run holds it (or that
 * run's lease has lapsed) and re-checks just before the R2 delete that it still holds it at the
 * generation it took, so two runs at once never both act on one key, and a slow run that lost
 * its claim to a later one, or to an upload, deletes nothing.
 */
export async function sweepPictures(
  env: { dbs: Databases; OBJECTS: R2Bucket },
  now: number,
  owner: string,
) {
  const db = env.dbs.publishers;
  await sweepPictureRows(env.dbs, now, batch.pictureRows);
  const claims = await startPictureDeletes(db, now, batch.pictureObjects, owner);
  const doomed = await heldPictureDeletes(db, owner, claims);
  if (doomed.length > 0) {
    await env.OBJECTS.delete(doomed);
    await finishPictureDeletes(
      db,
      owner,
      claims.filter((claim) => doomed.includes(claim.key)),
    );
  }
  for (const prefix of picturePrefixes) {
    const after = await sweepCursor(db, prefix);
    const page = await env.OBJECTS.list({
      prefix,
      limit: batch.pictureObjects,
      ...(after === undefined ? {} : { startAfter: after }),
    });
    const old = page.objects
      .filter((object) => object.uploaded.getTime() < now - pictureGraceMs)
      .map((object) => object.key);
    await claimPictures(db, old, now, owner);
    await setSweepCursor(db, prefix, page.truncated ? page.objects.at(-1)?.key : undefined);
  }
}

async function scanJobs(env: Env, dbs: Databases, now: number) {
  const { results } = await dbs.publishers
    .prepare(
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
      dbs,
      draft,
      { handle: draft.handle, official: draft.official === 1 },
      now,
    );
}

async function staleDrafts(env: Env, dbs: Databases, now: number) {
  const { results } = await dbs.publishers
    .prepare(
      "SELECT id FROM drafts WHERE updated < ?1 AND publishing IS NULL ORDER BY updated LIMIT ?2",
    )
    .bind(now - draftDays * day, batch.drafts)
    .all<{ id: string }>();
  for (const draft of results) await deleteDraft(dbs.publishers, env.OBJECTS, draft.id);
}

async function expire(dbs: Databases, now: number) {
  await eachCatalogue(dbs, ({ db }) =>
    db.prepare("DELETE FROM transfers WHERE expires <= ?1").bind(now).run(),
  );
  await dbs.publishers
    .prepare("DELETE FROM spent_person_grants WHERE expires <= ?1")
    .bind(now)
    .run();
  // A passed token stays: the weekly re-check reads it again.
  await dbs.publishers
    .prepare("DELETE FROM verification_challenges WHERE state != 'passed' AND expires <= ?1")
    .bind(now)
    .run();
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
