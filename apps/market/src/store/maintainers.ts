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
import { bumpGeneration, refreshEntry, refreshPublisherEntries } from "./entries.ts";
import { pendingListingOf, type EntryTable } from "./rows.ts";

/*
 * The maintainers' side of D1 (ADR 0173 §9, §10, §13): what waits for them, and their decisions
 * on versions, listing edits, publishers, collections and appeals. Every change to a version is
 * batched with its entry's generation and followed by the entry's refresh.
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

export async function queue(db: D1Database, bucket: R2Bucket, now: number): Promise<Queue> {
  const [held, listings, verifications, appeals] = await Promise.all([
    db
      .prepare(
        `SELECT v.type, v.name, v.version, v.hash, v.published, p.id AS publisher_id,
            p.name AS publisher_name, p.created, p.live_versions
          FROM versions v JOIN entries e ON e.type = v.type AND e.name = v.name
          JOIN publishers p ON p.id = e.publisher
          WHERE v.state = 'held' ORDER BY v.published LIMIT 500`,
      )
      .all<
        Key & {
          hash: string;
          published: number;
          publisher_id: string;
          publisher_name: string;
          created: number;
          live_versions: number;
        }
      >(),
    db
      .prepare(
        `SELECT e.*, p.id AS publisher_id, p.name AS publisher_name FROM entries e
          JOIN publishers p ON p.id = e.publisher
          WHERE e.pending_listing IS NOT NULL ORDER BY e.type, e.name LIMIT 500`,
      )
      .all<EntryTable & { publisher_id: string; publisher_name: string }>(),
    db
      .prepare(
        `SELECT id, name, proofs, verification_at, created, verification_flag FROM publishers
          WHERE verification = 'applied' OR verification_flag IS NOT NULL
          ORDER BY COALESCE(verification_at, created) LIMIT 500`,
      )
      .all<{
        id: string;
        name: string;
        proofs: string;
        verification_at: number | null;
        created: number;
        verification_flag: string | null;
      }>(),
    db
      .prepare(
        `SELECT a.*, p.name AS publisher_name, v.state AS version_state, v.block_reason
          FROM appeals a JOIN publishers p ON p.id = a.publisher
          LEFT JOIN versions v ON v.type = a.type AND v.name = a.name AND v.version = a.version
          WHERE a.state = 'open' ORDER BY a.at LIMIT 500`,
      )
      .all<{
        id: string;
        type: string;
        name: string;
        version: string;
        publisher: string;
        publisher_name: string;
        note: string;
        replacement: string | null;
        at: number;
        state: string;
        answer: string | null;
        version_state: string | null;
        block_reason: string | null;
      }>(),
  ]);
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

export async function scanContext(db: D1Database, now: number): Promise<MarketScanContextBody> {
  const [entries, publishers] = await Promise.all([
    db
      .prepare(
        `SELECT e.type, e.name, p.name AS publisher,
            (SELECT COALESCE(SUM(v.downloads), 0) FROM versions v
              WHERE v.type = e.type AND v.name = e.name) AS downloads
          FROM entries e JOIN publishers p ON p.id = e.publisher
          ORDER BY e.type, e.name LIMIT 50000`,
      )
      .all<{ type: string; name: string; publisher: string; downloads: number }>(),
    db
      .prepare(
        "SELECT name, display_name, verified, created, live_versions FROM publishers LIMIT 50000",
      )
      .all<{
        name: string;
        display_name: string;
        verified: number;
        created: number;
        live_versions: number;
      }>(),
  ]);
  return {
    entries: entries.results,
    verified: publishers.results
      .filter((row) => row.verified === 1)
      .map((row) => ({ handle: row.name, displayName: row.display_name || row.name })),
    newPublishers: publishers.results
      .filter((row) =>
        isNewPublisher({ created: row.created, liveVersions: row.live_versions }, now),
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

/** Suspends, restores or marks deleted a publisher; its entries follow (ADR 0173 §2). */
export async function setPublisherState(
  db: D1Database,
  handle: string,
  state: MarketPublisherState,
  reason: string | undefined,
  now: number,
): Promise<Decided> {
  const row = await db
    .prepare("UPDATE publishers SET state = ?2, state_reason = ?3 WHERE name = ?1 RETURNING id")
    .bind(handle, state, reason ?? null)
    .first<{ id: string }>();
  if (!row) return "missing";
  await refreshPublisherEntries(db, row.id, now);
  return "done";
}

/** A publisher's live versions, for `--withdraw-all`. */
export async function publisherVersions(db: D1Database, handle: string) {
  const publisher = await db
    .prepare("SELECT id, name, state FROM publishers WHERE name = ?1")
    .bind(handle)
    .first<{ id: string; name: string; state: MarketPublisherState }>();
  if (!publisher) return undefined;
  const { results } = await db
    .prepare(
      `SELECT v.type, v.name, v.version, v.hash FROM versions v
        JOIN entries e ON e.type = v.type AND e.name = v.name
        WHERE e.publisher = ?1 AND v.listed = 1 AND v.withdrawn IS NULL
        ORDER BY v.type, v.name, v.version LIMIT 10000`,
    )
    .bind(publisher.id)
    .all<Key & { hash: string }>();
  return {
    publisher: { id: publisher.id, name: publisher.name },
    state: publisher.state,
    live: results,
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
 * Answers an open appeal. Approving releases the version for the signer, as `--approve` does
 * (its re-scan still refuses a block); keeping it leaves the version as it is.
 */
export async function answerAppeal(
  db: D1Database,
  id: string,
  answer: { answer: string; decision: "approve" | "keep" },
  now: number,
): Promise<Decided> {
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
  if (answer.decision === "approve") await decideHold(db, appeal, "approve", now);
  return "done";
}
