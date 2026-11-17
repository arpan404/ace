import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyWithdrawn } from "@ace/marketplace";
import { keySetOf, sampleSkill, signedWithdrawn } from "@ace/marketplace/testing";
import { catalogueOf, marketKey, startMarket, type Market } from "./testing/harness.ts";
import { publishLive } from "./testing/discover-harness.ts";
import { indexNames } from "./testing/publisher-harness.ts";
import { syncDue } from "./store/copies.ts";
import { aggregateDownloads } from "./store/downloads.ts";
import { signedText, upsertSigned } from "./store/lists.ts";
import { applyWithdrawn } from "./store/signer.ts";
import { recordSizes } from "./store/sizes.ts";
import { reconcileUsage } from "./store/usage.ts";

/*
 * The cron's cross-database work (ADR 0173 §16) when a step is cut off or a backlog is large:
 * work left between two databases is finished by a later run, pages stay bounded, and nothing a
 * slower run read can undo what a faster one wrote.
 */

let market: Market;
beforeAll(async () => {
  market = await startMarket();
}, 60_000);
afterAll(() => market.close());

/** A catalogue whose connection is lost right after its next batch commits. */
function crashAfterBatch(db: D1Database): D1Database {
  let committed = false;
  return new Proxy(db, {
    get(target, name, receiver) {
      if (name === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          committed = true;
          return results;
        };
      if (name === "prepare" && committed)
        return () => {
          throw new Error("the connection was lost");
        };
      return Reflect.get(target, name, receiver);
    },
  });
}

const live = (name: string, publisher: string) =>
  publishLive(market, {
    type: "spade-skill",
    name,
    files: sampleSkill(name),
    account: `acct_${publisher}`,
    publisher,
  });

const publisherId = async (handle: string) =>
  (
    await market.dbs.publishers
      .prepare("SELECT id FROM publishers WHERE name = ?1")
      .bind(handle)
      .first<{ id: string }>()
  )?.id ?? "";

describe("a withdrawn list marked but not refreshed", () => {
  it("takes an entry whose only version it withdrew out of the index on the next cron run", async () => {
    const { hash } = await live("only-withdrawn", "pull-folk");
    // Every other cron step settled first, so only the withdrawn list's work is left.
    await market.scheduled();
    const signed = signedWithdrawn(
      [
        {
          hash,
          reason: "Pulled",
          type: "spade-skill",
          name: "only-withdrawn",
          version: "1.0.0",
        },
      ],
      { key: marketKey, issued: 1_950_000_000_000 },
    );
    const list = verifyWithdrawn(signed, keySetOf(marketKey));
    await upsertSigned(market.dbs.lists, "withdrawn", {
      issued: list.issued,
      signed: signedText(signed),
    }).run();
    // The marks commit; the connection is lost before the entry is refreshed.
    await expect(
      applyWithdrawn(crashAfterBatch(catalogueOf(market, "spade-skill")), list, Date.now()),
    ).rejects.toThrow("lost");
    expect(await indexNames(market)).toContain("spade-skill/only-withdrawn");

    await market.scheduled();
    expect(await indexNames(market)).not.toContain("spade-skill/only-withdrawn");
  });
});

describe("download folds", () => {
  it("a fold that read older totals than one already folded lowers nothing and restamps nothing", async () => {
    await live("fold-race", "fold-race-folk");
    await market.dbs.counts
      .prepare(
        "INSERT INTO version_totals (type, name, version, downloads) VALUES ('spade-skill', 'fold-race', '1.0.0', 7)",
      )
      .run();
    await aggregateDownloads(market.dbs, Date.now());
    const { stamp } = (await (await market.fetch("/v1/index")).json()) as { stamp: number };
    // A slower run read the totals when there were 5, and writes after the faster one.
    const stale = { type: "spade-skill", name: "fold-race", version: "1.0.0", downloads: 5 };
    const counts = new Proxy(market.dbs.counts, {
      get(target, name, receiver) {
        if (name !== "prepare") return Reflect.get(target, name, receiver);
        return (sql: string) =>
          sql.includes("downloads != folded")
            ? {
                bind: (type: string) => ({
                  all: async () => ({ results: type === "spade-skill" ? [stale] : [] }),
                }),
              }
            : target.prepare(sql);
      },
    });
    await aggregateDownloads({ ...market.dbs, counts }, Date.now());
    const counted = await catalogueOf(market, "spade-skill")
      .prepare("SELECT counted FROM versions WHERE name = 'fold-race'")
      .first<{ counted: number }>();
    expect(counted?.counted).toBe(7);
    const folded = await market.dbs.counts
      .prepare("SELECT folded FROM version_totals WHERE name = 'fold-race'")
      .first<{ folded: number }>();
    expect(folded?.folded).toBe(7);
    const since = (await (await market.fetch(`/v1/index?since=${stamp}`)).json()) as {
      entries: { name: string }[];
    };
    expect(since.entries.map((entry) => entry.name)).not.toContain("fold-race");
  });
});

describe("bounded pages", () => {
  it("a publisher's copy is repaired a page at a time and recorded synced only when every entry is", async () => {
    for (const name of ["paged-a", "paged-b", "paged-c"]) await live(name, "paged-folk");
    const id = await publisherId("paged-folk");
    await market.dbs.publishers
      .prepare("UPDATE publishers SET state = 'suspended' WHERE id = ?1")
      .bind(id)
      .run();
    const listed = async () =>
      (await indexNames(market)).filter((name) => name.startsWith("spade-skill/paged-")).length;
    const synced = async () =>
      (
        await market.dbs.publishers
          .prepare("SELECT synced = revision AS done FROM publishers WHERE id = ?1")
          .bind(id)
          .first<{ done: number }>()
      )?.done;
    await syncDue(market.dbs, Date.now(), { publishers: 10, entries: 1 });
    expect(await listed()).toBe(2);
    expect(await synced()).toBe(0);
    for (let run = 0; run < 10 && (await synced()) !== 1; run++)
      await syncDue(market.dbs, Date.now(), { publishers: 10, entries: 1 });
    expect(await listed()).toBe(0);
    expect(await synced()).toBe(1);
  });

  it("a publisher's charges are reconciled a page at a time and stale ones dropped only when the pass is done", async () => {
    for (const name of ["ledger-a", "ledger-b", "ledger-c"]) await live(name, "ledger-folk");
    const id = await publisherId("ledger-folk");
    await market.dbs.publishers.batch([
      market.dbs.publishers.prepare("DELETE FROM charges WHERE publisher = ?1").bind(id),
      market.dbs.publishers
        .prepare(
          "INSERT INTO charges (item, publisher, size, at) VALUES ('spade-skill/ghost/1.0.0', ?1, 99, 0)",
        )
        .bind(id),
    ]);
    const items = async () =>
      (
        await market.dbs.publishers
          .prepare("SELECT item FROM charges WHERE publisher = ?1 ORDER BY item")
          .bind(id)
          .all<{ item: string }>()
      ).results.map((row) => row.item);
    const now = Date.now();
    expect(await reconcileUsage(market.dbs, id, now, { versions: 1 })).toBe(false);
    expect(await items()).toEqual(["spade-skill/ghost/1.0.0", "spade-skill/ledger-a/1.0.0"]);
    let done = false;
    for (let run = 0; run < 10 && !done; run++)
      done = await reconcileUsage(market.dbs, id, now, { versions: 1 });
    expect(done).toBe(true);
    expect(await items()).toEqual([
      "spade-skill/ledger-a/1.0.0",
      "spade-skill/ledger-b/1.0.0",
      "spade-skill/ledger-c/1.0.0",
    ]);
  });
});

describe("the daily size record", () => {
  it("a day recorded for some databases only is finished for the rest", async () => {
    // A day no other test's cron run recorded.
    const now = Date.now() + 10 * 86_400_000;
    const today = Math.floor(now / 86_400_000);
    await market.dbs.counts
      .prepare("INSERT INTO database_sizes (day, database, bytes) VALUES (?1, 'suit', 1)")
      .bind(today)
      .run();
    await recordSizes(market.dbs, now);
    const recorded = await market.dbs.counts
      .prepare("SELECT database FROM database_sizes WHERE day = ?1 ORDER BY database")
      .bind(today)
      .all<{ database: string }>();
    expect(recorded.results.map((row) => row.database)).toEqual([
      "counts",
      "lists",
      "moderation",
      "publishers",
      "spade-bot",
      "spade-plugin",
      "spade-skill",
      "suit",
    ]);
  });
});
