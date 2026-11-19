import { readFeedEntry } from "@ace/marketplace";
import {
  MarketDiscoverBody,
  MarketPublisherBody,
  type MarketEntrySummary,
  type MarketOperation,
  type MarketResult,
} from "@ace/protocol/marketplace";
import { MarketHttpError, type MarketHttp } from "./http.ts";
import { summaryOf, type RowMarks } from "./listings.ts";
import { workerError } from "./publish.ts";
import type { MarketStore, StoredSource } from "./store.ts";

/*
 * Discover, publisher pages and abuse reports (ADR 0174 §3, §6, §7). Entries are index entries,
 * read as the index is, with "Verified" and "By ace" from the signed lists only. The last
 * Discover the market answered is kept as it came, so Discover answers offline from it and is
 * read again through the same parse.
 */

const discoverKey = "discover";

type ErrorResult = Extract<MarketResult, { op: "error" }>;
const failure = (code: ErrorResult["code"], message: string): ErrorResult => ({
  op: "error",
  code,
  message: message.slice(0, 2000),
});

function summaries(source: StoredSource, marks: RowMarks, items: readonly unknown[]) {
  const out: MarketEntrySummary[] = [];
  for (const item of items) {
    const entry = readFeedEntry(item);
    if (!("problem" in entry)) out.push(summaryOf(source, entry, marks));
  }
  return out;
}

const one = (source: StoredSource, marks: RowMarks, item: unknown) =>
  item === undefined ? undefined : summaries(source, marks, [item])[0];

function discoverOf(
  body: MarketDiscoverBody,
  readAt: number,
  source: StoredSource,
  marks: RowMarks,
) {
  const { badges } = marks;
  const hero = one(source, marks, body.hero);
  return {
    ...(hero ? { hero } : {}),
    featured: summaries(source, marks, body.featured),
    trending: body.trending.flatMap((row) => {
      const entry = one(source, marks, row.entry);
      return entry ? [{ entry, rank: row.rank, movement: row.movement, week: row.week }] : [];
    }),
    fresh: summaries(source, marks, body.fresh),
    collections: body.collections.map((collection) => ({
      id: collection.id,
      title: collection.title,
      line: collection.line,
      entries: summaries(source, marks, collection.entries),
    })),
    publishers: body.publishers.map(({ official: _claimed, ...publisher }) => ({
      ...publisher,
      // Top publishers carry handles, not ids: the signed list names both.
      verified: badges.verifiedHandle(publisher.handle),
      ...(badges.officialHandle(publisher.handle) ? { official: true } : {}),
    })),
    rankedAt: body.rankedAt,
    readAt,
  };
}

export async function discover(
  ports: { store: MarketStore; http: MarketHttp | undefined; marks: RowMarks; now: () => number },
  source: StoredSource | undefined,
): Promise<MarketResult> {
  if (!source?.enabled) return failure("unavailable", "market.acehq.dev is turned off");
  let problem = "The market can't be reached, and Discover hasn't been read yet";
  if (ports.http)
    try {
      const raw = await ports.http.discover();
      if (MarketDiscoverBody.safeParse(raw).success)
        ports.store.setMeta(discoverKey, JSON.stringify({ readAt: ports.now(), body: raw }));
      else problem = "The market's Discover isn't in a form this build reads";
    } catch (error) {
      if (error instanceof MarketHttpError && error.status !== undefined && error.status < 500)
        problem = `The market answered ${error.status}`;
    }
  const kept = ports.store.meta(discoverKey);
  if (!kept) return failure("unavailable", problem);
  const stored: unknown = JSON.parse(kept);
  const readAt =
    typeof stored === "object" && stored !== null && "readAt" in stored ? Number(stored.readAt) : 0;
  const body = MarketDiscoverBody.safeParse(
    typeof stored === "object" && stored !== null && "body" in stored ? stored.body : undefined,
  );
  if (!body.success) return failure("unavailable", problem);
  return { op: "discover", discover: discoverOf(body.data, readAt, source, ports.marks) };
}

/** A publisher's public page; its mark and proofs from the signed verified list only. */
export async function publisherPage(
  ports: { http: MarketHttp | undefined; marks: RowMarks },
  source: StoredSource | undefined,
  handle: string,
): Promise<MarketResult> {
  if (!source?.enabled || !ports.http)
    return failure("unavailable", "market.acehq.dev is turned off");
  let raw: unknown;
  try {
    raw = await ports.http.publisher(handle);
  } catch (error) {
    if (error instanceof MarketHttpError && error.status === 404)
      return failure("not_found", `There is no publisher ${handle}`);
    return failure("unavailable", error instanceof Error ? error.message : "The market failed");
  }
  const body = MarketPublisherBody.safeParse(raw);
  if (!body.success)
    return failure("failed", "The market's publisher page isn't in a form this build reads");
  const { official: _claimed, ...profile } = body.data.profile;
  const { badges } = ports.marks;
  const verified = badges.verified(profile.id);
  return {
    op: "publisher",
    page: {
      profile: {
        ...profile,
        verified,
        ...(badges.official(profile.id) ? { official: true } : {}),
        proofs: verified ? badges.proofs(profile.id) : [],
      },
      pinned: summaries(source, ports.marks, body.data.pinned),
      entries: summaries(source, ports.marks, body.data.entries),
      downloads: body.data.downloads,
      ...(badges.official(profile.id) ? { official: true } : {}),
    },
  };
}

/** An abuse report: anonymous, no grant, nothing about this machine sent. */
export async function report(
  http: MarketHttp | undefined,
  operation: Extract<MarketOperation, { op: "report" }>,
): Promise<MarketResult> {
  if (!http) return failure("unavailable", "market.acehq.dev is turned off");
  const { op: _op, ...body } = operation;
  let reply;
  try {
    reply = await http.send("POST", "/v1/reports", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return failure("unavailable", error instanceof Error ? error.message : "The market failed");
  }
  if (reply.status < 200 || reply.status >= 300) return workerError(reply.status, reply.body);
  return { op: "done" };
}
