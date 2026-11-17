import type {
  MarketCollection,
  MarketPublisherState,
  MarketQueueBody,
  MarketScanContextBody,
  MarketScanReport,
  MarketVerificationProof,
} from "@ace/protocol/marketplace";
import { versionReportKey } from "../context.ts";
import { isNewPublisher } from "../rules.ts";
import { syncPublisher } from "./copies.ts";
import { fromCatalogues, type Databases } from "./databases.ts";
import { bumpGeneration, refreshEntry } from "./entries.ts";
import { markUsageDirty } from "./me-limits.ts";
import { pendingListingOf, type EntryTable } from "./rows.ts";

/*
 * The maintainers' side of D1 (ADR 0173 §9, §10, §13, §16): what waits for them, read over every
 * catalogue and the publishers and moderation databases, and their decisions on versions,
 * listing edits, publishers, collections and appeals. Every change to a version is batched with
 * its entry's generation in its catalogue and followed by the entry's refresh.
 */

type Key = { type: string; name: string; version: string };
type Queue = MarketQueueBody;

async function report(bucket: R2Bucket, key: Key): Promise<MarketScanReport | undefined> {
  const stored = await bucket.get(versionReportKey(key));
  // The Worker wrote it (ADR 0125).
  return stored ? ((await stored.json()) as MarketScanReport) : undefined;
}

const withAccount = (proofs: MarketVerificationProof[]): MarketVerificationProof[] =>
  proofs.some((proof) => proof.kind === "account") ? proofs : [{ kind: "account" }, ...proofs];

const queueLimit = 500;

type HeldRow = Key & {
  hash: string;
  published: number;
  publisher_id: string;
  publisher_name: string;
  created: number;
  live_versions: number;
};
type AppealRow = {
  id: string;
  type: string;
  name: string;
  version: string;
  publisher: string;
  note: string;
  replacement: string | null;
  at: number;
  state: string;
  answer: string | null;
};
type ListingRow = EntryTable & { publisher_id: string; publisher_name: string };

/** The versions' states and block reasons for these appeals, from their catalogues. */
async function appealVersions(dbs: Databases, appeals: readonly AppealRow[]) {
  const keys = JSON.stringify(appeals.map((row) => `${row.type}/${row.name}@${row.version}`));
  const rows = await fromCatalogues(dbs, async ({ db }) => {
    const { results } = await db
      .prepare(
        `SELECT type, name, version, state, block_reason FROM versions
          WHERE (type || '/' || name || '@' || version) IN (SELECT value FROM json_each(?1))`,
      )
      .bind(keys)
      .all<Key & { state: string; block_reason: string | null }>();
    return results;
  });
  return new Map(rows.map((row) => [`${row.type}/${row.name}@${row.version}`, row]));
}

export async function queue(dbs: Databases, bucket: R2Bucket, now: number): Promise<Queue> {
  const [heldRows, listingRows, verifications, appealRows, live] = await Promise.all([
    fromCatalogues(dbs, async ({ db }) => {
      const { results } = await db
        .prepare(
          `SELECT v.type, v.name, v.version, v.hash, v.published, p.id AS publisher_id,
              p.name AS publisher_name, p.created, p.live_versions
            FROM versions v JOIN entries e ON e.type = v.type AND e.name = v.name
            JOIN publisher_copies p ON p.id = e.publisher
            WHERE v.state = 'held' ORDER BY v.published LIMIT ${queueLimit}`,
        )
        .all<HeldRow>();
      return results;
    }),
    fromCatalogues(dbs, async ({ db }) => {
      const { results } = await db
        .prepare(
          `SELECT e.*, p.id AS publisher_id, p.name AS publisher_name FROM entries e
            JOIN publisher_copies p ON p.id = e.publisher
            WHERE e.pending_listing IS NOT NULL ORDER BY e.type, e.name LIMIT ${queueLimit}`,
        )
        .all<ListingRow>();
      return results;
    }),
    dbs.publishers
      .prepare(
        `SELECT id, name, proofs, verification_at, created, verification_flag FROM publishers
          WHERE verification = 'applied' OR verification_flag IS NOT NULL
          ORDER BY COALESCE(verification_at, created) LIMIT ${queueLimit}`,
      )
      .all<{
        id: string;
        name: string;
        proofs: string;
        verification_at: number | null;
        created: number;
        verification_flag: string | null;
      }>(),
    dbs.moderation
      .prepare(`SELECT * FROM appeals WHERE state = 'open' ORDER BY at LIMIT ${queueLimit}`)
      .all<AppealRow>(),
    // A publisher's live versions are the sum over the catalogues (§16).
    fromCatalogues(dbs, async ({ db }) => {
      const { results } = await db
        .prepare("SELECT id, live_versions FROM publisher_copies WHERE live_versions > 0")
        .all<{ id: string; live_versions: number }>();
      return results;
    }),
  ]);
  const liveOf = new Map<string, number>();
  for (const row of live) liveOf.set(row.id, (liveOf.get(row.id) ?? 0) + row.live_versions);
  const held = {
    results: heldRows
      .toSorted((a, b) => a.published - b.published)
      .slice(0, queueLimit)
      .map((row) => Object.assign(row, { live_versions: liveOf.get(row.publisher_id) ?? 0 })),
  };
  const listings = { results: listingRows.slice(0, queueLimit) };
  const versionsOf = await appealVersions(dbs, appealRows.results);
  const handles = await dbs.publishers
    .prepare("SELECT id, name FROM publishers WHERE id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify([...new Set(appealRows.results.map((row) => row.publisher))]))
    .all<{ id: string; name: string }>();
  const handleOf = new Map(handles.results.map((row) => [row.id, row.name]));
  const appeals = {
    results: appealRows.results.map((row) => {
      const version = versionsOf.get(`${row.type}/${row.name}@${row.version}`);
      return Object.assign(row, {
        publisher_name: handleOf.get(row.publisher) ?? "",
        version_state: version?.state ?? null,
        block_reason: version?.block_reason ?? null,
      });
    }),
  };
  const reports = await Promise.all(held.results.map((row) => report(bucket, row)));
  return {
    held: held.results.map((row, index) => {
      const scan = reports[index];
      const item: Queue["held"][number] = {
        type: row.type as Queue["held"][number]["type"],
        name: row.name,
        version: row.version,
        hash: row.hash,
        publisher: { id: row.publisher_id, name: row.publisher_name },
        newPublisher: isNewPublisher(
          { created: row.created, liveVersions: row.live_versions },
          now,
        ),
        published: row.published,
      };
      if (scan) item.scan = scan;
      return item;
    }),
    listings: listings.results.flatMap((row) => {
      const pending = pendingListingOf(row);
      return pending
        ? [
            {
              type: row.type as Queue["listings"][number]["type"],
              name: row.name,
              publisher: { id: row.publisher_id, name: row.publisher_name },
              listing: pending.listing,
              scan: pending.scan,
              at: pending.at,
            },
          ]
        : [];
    }),
    verifications: verifications.results.map((row) => {
      const item: Queue["verifications"][number] = {
        publisher: { id: row.id, name: row.name },
        proofs: withAccount(JSON.parse(row.proofs) as MarketVerificationProof[]),
        at: row.verification_at ?? row.created,
      };
      if (row.verification_flag) item.flagged = row.verification_flag;
      return item;
    }),
    appeals: appeals.results.map((row) => {
      const appeal: Queue["appeals"][number] = {
        id: row.id,
        type: row.type as Queue["appeals"][number]["type"],
        name: row.name,
        version: row.version,
        publisher: { id: row.publisher, name: row.publisher_name },
        note: row.note,
        at: row.at,
        state: "open",
        status: row.version_state === "blocked" ? "blocked" : "held",
      };
      if (row.replacement) appeal.replacement = row.replacement;
      if (row.block_reason) appeal.reason = row.block_reason;
      return appeal;
    }),
  };
}

export async function scanContext(dbs: Databases, now: number): Promise<MarketScanContextBody> {
  const [entries, publishers, live] = await Promise.all([
    fromCatalogues(dbs, async ({ db }) => {
      const { results } = await db
        .prepare(
          `SELECT e.type, e.name, p.name AS publisher,
              (SELECT COALESCE(SUM(v.counted), 0) FROM versions v
                WHERE v.type = e.type AND v.name = e.name) AS downloads
            FROM entries e JOIN publisher_copies p ON p.id = e.publisher
            ORDER BY e.type, e.name LIMIT 50000`,
        )
        .all<{ type: string; name: string; publisher: string; downloads: number }>();
      return results;
    }),
    dbs.publishers
      .prepare("SELECT id, name, display_name, verified, created FROM publishers LIMIT 50000")
      .all<{
        id: string;
        name: string;
        display_name: string;
        verified: number;
        created: number;
      }>(),
    fromCatalogues(dbs, async ({ db }) => {
      const { results } = await db
        .prepare("SELECT id, live_versions FROM publisher_copies WHERE live_versions > 0")
        .all<{ id: string; live_versions: number }>();
      return results;
    }),
  ]);
  const liveOf = new Map<string, number>();
  for (const row of live) liveOf.set(row.id, (liveOf.get(row.id) ?? 0) + row.live_versions);
  return {
    entries: entries.slice(0, 50000),
    verified: publishers.results
      .filter((row) => row.verified === 1)
      .map((row) => ({ handle: row.name, displayName: row.display_name || row.name })),
    newPublishers: publishers.results
      .filter((row) =>
        isNewPublisher({ created: row.created, liveVersions: liveOf.get(row.id) ?? 0 }, now),
      )
      .map((row) => row.name),
  };
}

export type Decided = "done" | "missing" | "conflict";

async function changeVersion(
  db: D1Database,
  key: Key,
  statement: D1PreparedStatement,
  now: number,
): Promise<Decided> {
  const [changed] = await db.batch([statement, bumpGeneration(db, key.type, key.name)]);
  if ((changed?.meta.changes ?? 0) === 0) {
    const exists = await db
      .prepare("SELECT 1 AS found FROM versions WHERE type = ?1 AND name = ?2 AND version = ?3")
      .bind(key.type, key.name, key.version)
      .first();
    return exists ? "conflict" : "missing";
  }
  await refreshEntry(db, key.type, key.name, now);
  return "done";
}

/**
 * Releases a held (or blocked, on appeal) version for the signer, covering its warns; or holds a
 * pending one. A listed version is past both.
 */
export async function decideHold(
  db: D1Database,
  key: Key,
  decision: "approve" | "hold",
  now: number,
): Promise<Decided> {
  const statement =
    decision === "approve"
      ? db.prepare(
          `UPDATE versions SET state = 'pending', approved = 1, block_reason = NULL
            WHERE type = ?1 AND name = ?2 AND version = ?3 AND listed = 0
              AND state IN ('held', 'pending', 'blocked')`,
        )
      : db.prepare(
          `UPDATE versions SET state = 'held'
            WHERE type = ?1 AND name = ?2 AND version = ?3 AND listed = 0
              AND state IN ('pending', 'held')`,
        );
  return changeVersion(db, key, statement.bind(key.type, key.name, key.version), now);
}

/** Refuses a version that isn't listed: the signer's scan or a maintainer's word. */
export async function blockVersion(
  db: D1Database,
  key: Key,
  reason: string,
  now: number,
): Promise<Decided> {
  return changeVersion(
    db,
    key,
    db
      .prepare(
        `UPDATE versions SET state = 'blocked', verdict = 'block', block_reason = ?4, approved = 0
          WHERE type = ?1 AND name = ?2 AND version = ?3 AND listed = 0`,
      )
      .bind(key.type, key.name, key.version, reason),
    now,
  );
}

/** A pending listing edit approved (shown from now) or refused (dropped). */
export async function decideListing(
  db: D1Database,
  entry: { type: string; name: string },
  approve: boolean,
  now: number,
): Promise<Decided> {
  const [changed] = await db.batch([
    db
      .prepare(
        `UPDATE entries SET listing = CASE WHEN ?3 = 1
              THEN json_extract(pending_listing, '$.listing') ELSE listing END,
            pending_listing = NULL, generation = generation + 1
          WHERE type = ?1 AND name = ?2 AND pending_listing IS NOT NULL`,
      )
      .bind(entry.type, entry.name, approve ? 1 : 0),
  ]);
  if ((changed?.meta.changes ?? 0) === 0) return "missing";
  await refreshEntry(db, entry.type, entry.name, now);
  return "done";
}

/**
 * Suspends, restores or marks deleted a publisher; its entries follow in every catalogue through
 * its copies (ADR 0173 §2, §16).
 */
export async function setPublisherState(
  dbs: Databases,
  handle: string,
  state: MarketPublisherState,
  reason: string | undefined,
  now: number,
): Promise<Decided> {
  const row = await dbs.publishers
    .prepare("UPDATE publishers SET state = ?2, state_reason = ?3 WHERE name = ?1 RETURNING id")
    .bind(handle, state, reason ?? null)
    .first<{ id: string }>();
  if (!row) return "missing";
  await syncPublisher(dbs, row.id, now);
  return "done";
}

/** A publisher's live versions over every catalogue, for `--withdraw-all`. */
export async function publisherVersions(dbs: Databases, handle: string) {
  const publisher = await dbs.publishers
    .prepare("SELECT id, name, state FROM publishers WHERE name = ?1")
    .bind(handle)
    .first<{ id: string; name: string; state: MarketPublisherState }>();
  if (!publisher) return undefined;
  const live = await fromCatalogues(dbs, async ({ db }) => {
    const { results } = await db
      .prepare(
        `SELECT v.type, v.name, v.version, v.hash FROM versions v
          JOIN entries e ON e.type = v.type AND e.name = v.name
          WHERE e.publisher = ?1 AND v.listed = 1 AND v.withdrawn IS NULL
          ORDER BY v.type, v.name, v.version LIMIT 10000`,
      )
      .bind(publisher.id)
      .all<Key & { hash: string }>();
    return results;
  });
  return {
    publisher: { id: publisher.id, name: publisher.name },
    state: publisher.state,
    live: live.slice(0, 10000),
  };
}

export async function setCollections(db: D1Database, list: readonly MarketCollection[]) {
  await db.batch([
    db.prepare("DELETE FROM collections"),
    ...list.map((collection, position) =>
      db
        .prepare(
          "INSERT INTO collections (position, id, title, line, entries) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(
          position,
          collection.id,
          collection.title,
          collection.line,
          JSON.stringify(collection.entries),
        ),
    ),
  ]);
}

export async function collections(db: D1Database): Promise<MarketCollection[]> {
  const { results } = await db
    .prepare("SELECT id, title, line, entries FROM collections ORDER BY position")
    .all<{ id: string; title: string; line: string; entries: string }>();
  return results.map((row) => ({
    id: row.id,
    title: row.title,
    line: row.line,
    entries: JSON.parse(row.entries) as MarketCollection["entries"],
  }));
}

/**
 * Answers an open appeal, in the moderation database. Approving then releases the version in its
 * catalogue for the signer, as `--approve` does (its re-scan still refuses a block); keeping it
 * leaves the version as it is. A release cut off after the answer is made again by
 * `--approve`, which answers as the appeal did.
 */
export async function answerAppeal(
  dbs: Databases,
  id: string,
  answer: { answer: string; decision: "approve" | "keep" },
  now: number,
): Promise<Decided> {
  const db = dbs.moderation;
  const appeal = await db
    .prepare(
      `UPDATE appeals SET state = ?2, answer = ?3, answered = ?4 WHERE id = ?1 AND state = 'open'
        RETURNING type, name, version`,
    )
    .bind(id, answer.decision === "approve" ? "approved" : "kept", answer.answer, now)
    .first<Key>();
  if (!appeal) {
    const exists = await db.prepare("SELECT 1 FROM appeals WHERE id = ?1").bind(id).first();
    return exists ? "conflict" : "missing";
  }
  const catalogue = dbs.catalogue(appeal.type);
  if (answer.decision === "approve" && catalogue) {
    await decideHold(catalogue, appeal, "approve", now);
    const owner = await catalogue
      .prepare("SELECT publisher FROM entries WHERE type = ?1 AND name = ?2")
      .bind(appeal.type, appeal.name)
      .first<{ publisher: string }>();
    if (owner) await markUsageDirty(dbs.publishers, owner.publisher, now).run();
  }
  return "done";
}
