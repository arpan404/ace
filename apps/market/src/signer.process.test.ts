import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signReviewMark } from "@ace/marketplace";
import { sampleSkill, sampleSuit, signedWithdrawn, testKey } from "@ace/marketplace/testing";
import {
  asSigner,
  manifestFor,
  marketKey,
  pendingPublisher,
  publish,
  publishSigned,
  put,
  startMarket,
  type Market,
} from "./testing/harness.ts";

let market: Market;
beforeAll(async () => {
  market = await startMarket();
});
afterAll(() => market.close());

const getJson = async <T>(path: string) => (await (await market.fetch(path)).json()) as T;
type Index = {
  stamp: number;
  full: boolean;
  entries: { type: string; name: string; version?: string; reviewed: boolean }[];
  removed: { type: string; name: string }[];
};

describe("the signer's routes", () => {
  it("refuse a caller without the signer's token", async () => {
    expect((await market.fetch("/v1/signer/pending")).status).toBe(401);
    const wrong = await market.fetch("/v1/signer/pending", {
      headers: { authorization: "Bearer signer-token-for-test" },
    });
    expect(wrong.status).toBe(401);
    expect((await market.fetch("/v1/signer/pending", { headers: asSigner })).status).toBe(200);
  });

  it("refuse a manifest signed by a key the market doesn't know", async () => {
    const files = sampleSkill("stranger-skill");
    await publish(market, { type: "spade-skill", name: "stranger-skill", files });
    const publisher = await pendingPublisher(market, "spade-skill", "stranger-skill");
    const response = await put(market, "/v1/signer/versions/spade-skill/stranger-skill/1.0.0", {
      manifest: manifestFor(
        { type: "spade-skill", name: "stranger-skill", files },
        { publisher, key: testKey("market", 1) },
      ),
    });
    expect(response.status).toBe(422);
    const index = await getJson<Index>("/v1/index");
    expect(index.entries.map((entry) => entry.name)).not.toContain("stranger-skill");
  });

  it("list only reviewed entries in featured, and refuse others", async () => {
    await publishSigned(market, {
      type: "suit",
      name: "harbour-dusk",
      files: sampleSuit(),
      reviewed: true,
    });
    await publishSigned(market, {
      type: "spade-skill",
      name: "unread-skill",
      files: sampleSkill("unread-skill"),
    });
    const refused = await put(market, "/v1/signer/featured", {
      entries: [
        { type: "suit", name: "harbour-dusk" },
        { type: "spade-skill", name: "unread-skill" },
      ],
    });
    expect(refused.status).toBe(422);
    const stored = await put(market, "/v1/signer/featured", {
      entries: [{ type: "suit", name: "harbour-dusk" }],
    });
    expect(stored.status).toBe(200);
    expect(await getJson("/v1/featured")).toEqual({
      entries: [{ type: "suit", name: "harbour-dusk" }],
    });
  });

  it("list only reviewed entries under a category", async () => {
    expect(
      (
        await put(market, "/v1/signer/categories", {
          categories: [{ id: "calm", title: "Calm" }],
        })
      ).status,
    ).toBe(200);
    await publishSigned(market, {
      type: "suit",
      name: "unreviewed-dusk",
      files: sampleSuit("unreviewed-dusk"),
    });
    expect(await getJson("/v1/categories")).toEqual({
      categories: [{ id: "calm", title: "Calm" }],
    });
    const found = await getJson<{ entries: { name: string }[] }>("/v1/search?q=&category=calm");
    expect(found.entries.map((entry) => entry.name)).toEqual(["harbour-dusk"]);
    const index = await getJson<Index>("/v1/index");
    const unreviewed = index.entries.find((entry) => entry.name === "unreviewed-dusk");
    expect(unreviewed).toMatchObject({ reviewed: false, categories: [] });
  });

  it("a withdrawn version drops out of latest, and an entry with none left leaves the index", async () => {
    const one = await publishSigned(market, {
      type: "spade-skill",
      name: "pulled-skill",
      files: sampleSkill("pulled-skill"),
    });
    const two = await publishSigned(market, {
      type: "spade-skill",
      name: "pulled-skill",
      version: "1.1.0",
      files: sampleSkill("pulled-skill", { "more.md": "More." }),
    });
    const before = await getJson<Index>("/v1/index");
    expect(before.entries.find((entry) => entry.name === "pulled-skill")?.version).toBe("1.1.0");

    const first = await put(market, "/v1/signer/withdrawn", {
      withdrawn: signedWithdrawn([{ hash: two.hash, reason: "Deletes files." }], {
        key: marketKey,
        issued: 100,
      }),
    });
    expect(first.status).toBe(200);
    const after = await getJson<Index>(`/v1/index?since=${before.stamp}`);
    expect(after.entries.find((entry) => entry.name === "pulled-skill")?.version).toBe("1.0.0");
    const page = await getJson<{ versions: { version: string; withdrawn?: string }[] }>(
      "/v1/entries/spade-skill/pulled-skill",
    );
    expect(page.versions).toEqual([
      expect.objectContaining({ version: "1.1.0", withdrawn: "Deletes files." }),
      expect.not.objectContaining({ withdrawn: expect.anything() }),
    ]);
    // Whoever installed it can still fetch the same bytes.
    expect((await market.fetch(`/v1/objects/${two.hash}`)).status).toBe(200);

    const older = await put(market, "/v1/signer/withdrawn", {
      withdrawn: signedWithdrawn([], { key: marketKey, issued: 50 }),
    });
    expect(older.status).toBe(409);

    const both = await put(market, "/v1/signer/withdrawn", {
      withdrawn: signedWithdrawn(
        [
          { hash: one.hash, reason: "Also broken." },
          { hash: two.hash, reason: "Deletes files." },
        ],
        { key: marketKey, issued: 200 },
      ),
    });
    expect(both.status).toBe(200);
    const gone = await getJson<Index>(`/v1/index?since=${after.stamp}`);
    expect(gone.entries.map((entry) => entry.name)).not.toContain("pulled-skill");
    expect(gone.removed).toContainEqual({ type: "spade-skill", name: "pulled-skill" });
    const full = await getJson<Index>("/v1/index");
    expect(full.entries.map((entry) => entry.name)).not.toContain("pulled-skill");
    const list = await getJson<{ body: { issued: number } }>("/v1/withdrawn");
    expect(list.body.issued).toBe(200);
  });

  it("refuse a review mark naming other bytes", async () => {
    const review = signReviewMark(
      {
        format: "ace-market-review",
        type: "spade-skill",
        name: "unread-skill",
        hash: "0".repeat(64),
        reviewed: true,
        byAce: false,
        at: 1,
        key: marketKey.id,
      },
      marketKey,
    );
    const response = await put(market, "/v1/signer/reviews/spade-skill/unread-skill/1.0.0", {
      review,
    });
    expect(response.status).toBe(422);
    const index = await getJson<Index>("/v1/index");
    expect(index.entries.find((entry) => entry.name === "unread-skill")?.reviewed).toBe(false);
  });
});
