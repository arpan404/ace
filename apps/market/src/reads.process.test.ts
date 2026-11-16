import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseIndex, VersionBody, verifyManifest } from "@ace/marketplace";
import { folder, keySetOf, sampleSkill } from "@ace/marketplace/testing";
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

const versions = async () =>
  (
    (await (await market.fetch("/v1/entries/spade-skill/read-skill")).json()) as {
      versions: { version: string; downloads: number }[];
    }
  ).versions;

const downloads = async (version: string) =>
  (await versions()).find((row) => row.version === version)?.downloads;

describe("reading the catalog", () => {
  it("sets no cookie on any read route or page", async () => {
    for (const path of [
      "/v1/index",
      "/v1/search?q=read",
      "/v1/categories",
      "/v1/featured",
      "/v1/entries/spade-skill/read-skill",
      "/v1/entries/spade-skill/read-skill/1.0.0",
      `/v1/objects/${hashes["1.0.0"]}`,
      "/",
      "/search?q=read",
      "/spade-skill/read-skill",
    ]) {
      const response = await market.fetch(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("set-cookie"), path).toBeNull();
      await response.arrayBuffer();
    }
  });

  it("a download raises only that version's total", async () => {
    const response = await market.fetch(`/v1/objects/${hashes["1.0.0"]}`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    await response.arrayBuffer();
    // The read-route test above fetched it once too; its count lands after the response.
    await expect.poll(() => downloads("1.0.0")).toBe(2);
    await (await market.fetch(`/v1/objects/${hashes["1.0.0"]}`)).arrayBuffer();
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

  it("renders an entry's page with its review, downloads and a link that opens it in ace", async () => {
    const page = await (await market.fetch("/spade-skill/read-skill")).text();
    expect(page).toContain("By ace");
    expect(page).toMatch(/\d+ downloads?/);
    expect(page).toContain('href="ace://marketplace/spade-skill/read-skill"');
    expect(page).toContain("1.1.0");
  });

  it("escapes what publishers wrote", async () => {
    await publishSigned(market, {
      type: "spade-skill",
      name: "loud-skill",
      files: [
        ...sampleSkill("loud-skill"),
        ...folder({ "market.json": JSON.stringify({ line: '<img src=x onerror="alert(1)">' }) }),
      ],
    });
    const page = await (await market.fetch("/spade-skill/loud-skill")).text();
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(page).toContain("Not reviewed by ace");
  });

  it("answers an address that names nothing with a page saying so", async () => {
    const response = await market.fetch("/spade-skill/nothing-here");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Nothing in the marketplace has that address.");
  });
});
