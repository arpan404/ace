import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseIndex, verifyManifest } from "@ace/marketplace";
import { VersionBody } from "@ace/protocol/marketplace";
import { keySetOf, sampleSkill } from "@ace/marketplace/testing";
import { marketKey, publishSigned, startMarket, type Market } from "./testing/harness.ts";

let market: Market;
const hashes: Record<string, string> = {};
beforeAll(async () => {
  market = await startMarket();
  hashes["1.0.0"] = (
    await publishSigned(market, {
      type: "spade-skill",
      name: "read-skill",
      files: sampleSkill("read-skill"),
      reviewed: true,
      byAce: true,
    })
  ).hash;
  hashes["1.1.0"] = (
    await publishSigned(market, {
      type: "spade-skill",
      name: "read-skill",
      version: "1.1.0",
      files: sampleSkill("read-skill", { "more.md": "More." }),
      reviewed: true,
      byAce: true,
    })
  ).hash;
});
afterAll(() => market.close());

describe("the Worker is the API only", () => {
  it("answers GET / with JSON and no HTML", async () => {
    const response = await market.fetch("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ name: "ace market", api: "/v1" });
  });

  it.each(["/search", "/spade-skill/read-skill", "/v1/nothing-here"])(
    "answers %s with a JSON 404",
    async (path) => {
      const response = await market.fetch(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toMatchObject({ error: "not_found" });
    },
  );
});

const versions = async () =>
  (
    (await (await market.fetch("/v1/entries/spade-skill/read-skill")).json()) as {
      versions: { version: string; downloads: number }[];
    }
  ).versions;

const downloads = async (version: string) =>
  (await versions()).find((row) => row.version === version)?.downloads;

/** A request from one caller address. */
const from = (address: string) => ({ headers: { "cf-connecting-ip": address } });

describe("reading the catalog", () => {
  it("sets no cookie on any read route", async () => {
    for (const path of [
      "/v1/index",
      "/v1/search?q=read",
      "/v1/categories",
      "/v1/featured",
      "/v1/entries/spade-skill/read-skill",
      "/v1/entries/spade-skill/read-skill/1.0.0",
      `/v1/objects/${hashes["1.0.0"]}`,
      "/",
    ]) {
      const response = await market.fetch(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("set-cookie"), path).toBeNull();
      await response.arrayBuffer();
    }
  });

  it("serves an app the same whatever ace-client it sends, or none", async () => {
    const plain = await (await market.fetch("/v1/entries/spade-skill/read-skill")).text();
    for (const client of ["daemon/0.0.24-beta.1", "spade/development", "not a client"]) {
      const named = await market.fetch("/v1/entries/spade-skill/read-skill", {
        headers: { "ace-client": client },
      });
      expect(named.status, client).toBe(200);
      expect(await named.text(), client).toBe(plain);
    }
  });

  it("a download raises only that version's total", async () => {
    // Each caller counts once a minute per hash (ADR 0174 §6), so each fetch is another caller.
    const response = await market.fetch(`/v1/objects/${hashes["1.0.0"]}`, from("192.0.2.1"));
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    await response.arrayBuffer();
    // The read-route test above fetched it once too; its count lands after the response.
    await expect.poll(() => downloads("1.0.0")).toBe(2);
    await (await market.fetch(`/v1/objects/${hashes["1.0.0"]}`, from("192.0.2.2"))).arrayBuffer();
    await expect.poll(() => downloads("1.0.0")).toBe(3);
    expect(await downloads("1.1.0")).toBe(0);
  });

  it("serves an object only for a hash some signed version has", async () => {
    expect((await market.fetch(`/v1/objects/${"a".repeat(64)}`)).status).toBe(404);
  });

  it("answers the index with an ETag and 304 for a caller that has it", async () => {
    const first = await market.fetch("/v1/index");
    const etag = first.headers.get("etag");
    const index = parseIndex(await first.json());
    expect(index.full).toBe(true);
    expect(index.entries).toEqual([
      expect.objectContaining({
        name: "read-skill",
        version: "1.1.0",
        reviewed: true,
        byAce: true,
      }),
    ]);
    const again = await market.fetch("/v1/index", { headers: { "if-none-match": etag ?? "" } });
    expect(again.status).toBe(304);
  });

  it("since answers only what changed after the stamp", async () => {
    const { stamp } = parseIndex(await (await market.fetch("/v1/index")).json());
    const nothing = parseIndex(await (await market.fetch(`/v1/index?since=${stamp}`)).json());
    expect(nothing).toMatchObject({ full: false, entries: [], removed: [] });
    await publishSigned(market, {
      type: "spade-skill",
      name: "later-skill",
      files: sampleSkill("later-skill"),
    });
    const changed = parseIndex(await (await market.fetch(`/v1/index?since=${stamp}`)).json());
    expect(changed.entries.map((entry) => entry.name)).toEqual(["later-skill"]);
    expect(changed.stamp).toBeGreaterThan(stamp);
    expect((await market.fetch("/v1/index?since=soon")).status).toBe(400);
  });

  it("serves a version's signed manifest, which verifies with the market's key", async () => {
    const body = VersionBody.parse(
      await (await market.fetch("/v1/entries/spade-skill/read-skill/1.1.0")).json(),
    );
    expect(verifyManifest(body.manifest, keySetOf(marketKey))).toMatchObject({
      name: "read-skill",
      version: "1.1.0",
      hash: hashes["1.1.0"],
    });
    expect(body.review).toBeDefined();
    expect((await market.fetch("/v1/entries/spade-skill/read-skill/9.9.9")).status).toBe(404);
  });

  it("answers 404 for withdrawn before the first list is signed", async () => {
    expect((await market.fetch("/v1/withdrawn")).status).toBe(404);
  });
});
