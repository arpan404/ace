import { afterAll, beforeAll, expect, it } from "vitest";
import { MarketDiscoverBody } from "@ace/protocol/marketplace";
import { sampleSkill } from "@ace/marketplace/testing";
import { put, startMarket, type Market } from "./testing/harness.ts";
import { download, everyRow, publishLive } from "./testing/discover-harness.ts";

/*
 * Discover (ADR 0173 §6) through the Worker: anonymous download counting into hourly and daily
 * totals, the Discover body after the cron ranked, and search's sorts. Nothing per reader.
 */

let market: Market;
beforeAll(async () => {
  market = await startMarket();
});
afterAll(() => market.close());

const discover = async () =>
  MarketDiscoverBody.parse(await (await market.fetch("/v1/discover")).json());
const names = (entries: readonly unknown[]) =>
  entries.map((entry) => (entry as { name: string }).name);

it("counts a download once per caller and hash a minute, into hourly and daily totals, and keeps no address", async () => {
  const { hash } = await publishLive(market, {
    type: "spade-skill",
    name: "counted-twice",
    files: sampleSkill("counted-twice"),
  });
  const address = "203.0.113.77";
  // The same caller three times, then another caller: two counted, every fetch served.
  for (let attempt = 0; attempt < 3; attempt++)
    expect(await download(market, hash, address)).toBe(200);
  expect(await download(market, hash, "198.51.100.9")).toBe(200);

  const totals = async () =>
    market.db
      .prepare(
        `SELECT (SELECT downloads FROM versions WHERE name = 'counted-twice') AS total,
          (SELECT SUM(count) FROM downloads_hourly WHERE name = 'counted-twice') AS hourly,
          (SELECT SUM(count) FROM downloads_daily WHERE name = 'counted-twice'
            AND version = '1.0.0') AS daily`,
      )
      .first<{ total: number; hourly: number; daily: number }>();
  await expect.poll(totals).toEqual({ total: 2, hourly: 2, daily: 2 });
  const hour = await market.db
    .prepare("SELECT hour FROM downloads_hourly WHERE name = 'counted-twice'")
    .first<{ hour: number }>();
  expect(hour?.hour).toBe(Math.floor(Date.now() / 3_600_000));

  const kept = await everyRow(market);
  expect(kept).not.toContain(address);
  expect(kept).not.toContain("198.51.100.9");
});

it("answers Discover: featured with its hero, trending after the cron, New and notable, collections and top publishers", async () => {
  const popular = await publishLive(market, {
    type: "spade-skill",
    name: "popular-skill",
    files: sampleSkill("popular-skill"),
    account: "acct_pop",
    publisher: "popular-folk",
    reviewed: true,
  });
  await publishLive(market, {
    type: "spade-skill",
    name: "quiet-skill",
    files: sampleSkill("quiet-skill"),
    account: "acct_pop",
    publisher: "popular-folk",
    reviewed: true,
  });
  await publishLive(market, {
    type: "spade-skill",
    name: "unreviewed-skill",
    files: sampleSkill("unreviewed-skill"),
    account: "acct_pop",
    publisher: "popular-folk",
  });
  // Six callers each count once.
  for (let caller = 1; caller <= 6; caller++)
    await download(market, popular.hash, `192.0.2.${caller}`);
  await expect
    .poll(
      async () =>
        (
          await market.db
            .prepare("SELECT downloads FROM versions WHERE name = 'popular-skill'")
            .first<{ downloads: number }>()
        )?.downloads,
    )
    .toBe(6);
  expect(
    (
      await put(market, "/v1/signer/featured", {
        entries: [
          { type: "spade-skill", name: "quiet-skill" },
          { type: "spade-skill", name: "popular-skill" },
        ],
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await put(market, "/v1/signer/collections", {
        collections: [
          {
            id: "starters",
            title: "Starters",
            line: "Good first skills",
            entries: [
              { type: "spade-skill", name: "quiet-skill" },
              { type: "spade-skill", name: "never-published" },
            ],
          },
        ],
      })
    ).status,
  ).toBe(200);

  const before = await discover();
  expect(before.trending).toEqual([]);
  expect(before.rankedAt).toBe(0);

  await market.scheduled();
  const body = await discover();
  expect(names([body.hero])).toEqual(["quiet-skill"]);
  expect(names(body.featured)).toEqual(["quiet-skill", "popular-skill"]);
  // Only the entry past the minimum of 5 capped downloads trends; it is new to the ranking.
  expect(
    body.trending.map((row) => [names([row.entry])[0], row.rank, row.movement, row.week]),
  ).toEqual([["popular-skill", 1, { kind: "new" }, 6]]);
  expect(body.rankedAt).toBeGreaterThan(0);
  // Reviewed entries first listed within 30 days; the unreviewed one isn't notable.
  expect(names(body.fresh).toSorted()).toEqual(["popular-skill", "quiet-skill"]);
  expect(names(body.fresh)).not.toContain("unreviewed-skill");
  // A collection shows only entries still listed and visible.
  expect(body.collections.map((collection) => [collection.id, names(collection.entries)])).toEqual([
    ["starters", ["quiet-skill"]],
  ]);
  expect(body.publishers[0]).toMatchObject({
    handle: "popular-folk",
    verified: false,
    entries: 3,
    downloads: 6,
  });
});

const search = async (query: string) =>
  names(
    ((await (await market.fetch(`/v1/search?${query}`)).json()) as { entries: unknown[] }).entries,
  );

it("sorts search by downloads, by first listing and by trending, and filters by publisher", async () => {
  expect((await search("publisher=popular-folk&sort=downloads"))[0]).toBe("popular-skill");
  expect(await search("publisher=popular-folk&sort=new")).toEqual([
    "unreviewed-skill",
    "quiet-skill",
    "popular-skill",
  ]);
  expect((await search("sort=trending"))[0]).toBe("popular-skill");
  expect(await search("publisher=popular-folk&sort=new&offset=2")).toEqual(["popular-skill"]);
  expect(await search("publisher=nobody-here")).toEqual([]);
});

it("measures movement against last week's whole ranking, its leader included after it drops out", async () => {
  for (const name of ["faded-leader", "steady-second"])
    await publishLive(market, {
      type: "spade-skill",
      name,
      files: sampleSkill(name),
      account: "acct_movers",
      publisher: "movers",
    });
  // Last week: the leader 30 an hour, the second 20. This week only the second downloads.
  const hour = Math.floor(Date.now() / 3_600_000);
  const rows: [string, number, number][] = [];
  for (let ago = 170; ago <= 180; ago++)
    rows.push(["faded-leader", hour - ago, 30], ["steady-second", hour - ago, 20]);
  for (let ago = 1; ago <= 11; ago++) rows.push(["steady-second", hour - ago, 20]);
  await market.db.batch(
    rows.map(([name, at, count]) =>
      market.db
        .prepare(
          "INSERT INTO downloads_hourly (type, name, hour, count) VALUES ('spade-skill', ?1, ?2, ?3)",
        )
        .bind(name, at, count),
    ),
  );
  await market.scheduled();
  const body = await discover();
  const row = (name: string) => body.trending.find((item) => names([item.entry])[0] === name);
  expect(row("faded-leader")).toBeUndefined();
  expect(row("steady-second")).toMatchObject({ rank: 1, movement: { kind: "up", by: 1 } });
});
