import { afterAll, beforeAll, expect, it } from "vitest";
import { sampleSkill } from "@ace/marketplace/testing";
import { publishSigned, startMarket, type Market } from "./testing/harness.ts";

/*
 * Download totals reach `since` readers (ADR 0168 §3, §10): a download changes no stamp by
 * itself, and the scheduled aggregation folds new totals into the index with one stamp.
 */

let market: Market;
beforeAll(async () => {
  market = await startMarket();
});
afterAll(() => market.close());

type Index = { stamp: number; entries: { name: string; downloads: number }[] };
const index = async (since?: number) =>
  (await (
    await market.fetch(since === undefined ? "/v1/index" : `/v1/index?since=${since}`)
  ).json()) as Index;
const live = async () =>
  (
    (await (await market.fetch("/v1/entries/spade-skill/counted-skill")).json()) as {
      versions: { downloads: number }[];
    }
  ).versions[0]?.downloads;

it("folds downloads into the index's changes when the aggregation runs, not on every download", async () => {
  await publishSigned(market, {
    type: "spade-skill",
    name: "counted-skill",
    files: sampleSkill("counted-skill"),
  });
  const before = await index();
  const hash = (
    (await (await market.fetch("/v1/entries/spade-skill/counted-skill")).json()) as {
      versions: { hash: string }[];
    }
  ).versions[0]?.hash;
  await (await market.fetch(`/v1/objects/${hash}`)).arrayBuffer();
  await expect.poll(live).toBe(1);
  expect((await index(before.stamp)).entries).toEqual([]);

  await market.scheduled();
  const after = await index(before.stamp);
  expect(after.entries).toEqual([expect.objectContaining({ name: "counted-skill", downloads: 1 })]);
  expect(after.stamp).toBeGreaterThan(before.stamp);
  // Nothing new to fold: the next run moves nothing.
  await market.scheduled();
  expect((await index(after.stamp)).entries).toEqual([]);
});
