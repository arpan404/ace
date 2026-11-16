import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readArchive, typeLimits } from "@ace/marketplace";
import { folder, sampleSkill, sampleSuit } from "@ace/marketplace/testing";
import {
  asSigner,
  cloudGrant,
  manifestFor,
  marketGrant,
  pendingPublisher,
  publish,
  publishSigned,
  put,
  relayGrant,
  startMarket,
  type Market,
} from "./testing/harness.ts";

let market: Market;
beforeAll(async () => {
  market = await startMarket();
});
afterAll(() => market.close());

const indexNames = async () => {
  const body = (await (await market.fetch("/v1/index")).json()) as {
    entries: { type: string; name: string }[];
  };
  return body.entries.map((entry) => `${entry.type}/${entry.name}`);
};

describe("publishing", () => {
  it("an upload that fails a check returns its problems and is never stored or listed", async () => {
    const response = await publish(market, {
      type: "spade-skill",
      name: "leaky",
      files: sampleSkill("leaky", { ".env": "TOKEN=1" }),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string; problems: { message: string }[] };
    expect(body.error).toBe("refused");
    expect(body.problems.length).toBeGreaterThan(0);
    expect(await pendingPublisher(market, "spade-skill", "leaky")).toBeUndefined();
    expect(await indexNames()).not.toContain("spade-skill/leaky");
    expect((await market.fetch("/v1/entries/spade-skill/leaky")).status).toBe(404);
  });

  it("one that passes waits unlisted for the signer, then is listed and served", async () => {
    const files = sampleSkill("waiting-skill");
    const response = await publish(market, { type: "spade-skill", name: "waiting-skill", files });
    expect(response.status).toBe(201);
    const accepted = (await response.json()) as { status: string; hash: string };
    expect(accepted.status).toBe("pending");
    expect(await indexNames()).not.toContain("spade-skill/waiting-skill");
    expect((await market.fetch(`/v1/objects/${accepted.hash}`)).status).toBe(404);
    expect((await market.fetch("/v1/entries/spade-skill/waiting-skill/1.0.0")).status).toBe(404);

    const publisher = await pendingPublisher(market, "spade-skill", "waiting-skill");
    expect(publisher?.name).toBe("tester");
    const signed = await put(market, "/v1/signer/versions/spade-skill/waiting-skill/1.0.0", {
      manifest: manifestFor({ type: "spade-skill", name: "waiting-skill", files }, { publisher }),
    });
    expect(signed.status).toBe(200);
    expect(await indexNames()).toContain("spade-skill/waiting-skill");
    const object = await market.fetch(`/v1/objects/${accepted.hash}`);
    expect(object.status).toBe(200);
    const read = readArchive(new Uint8Array(await object.arrayBuffer()), typeLimits["spade-skill"]);
    expect(read.map((file) => file.path)).toEqual(["SKILL.md"]);
  });

  it("a version number never names other bytes, and the same bytes again are accepted", async () => {
    const first = sampleSkill("fixed-skill");
    await publishSigned(market, { type: "spade-skill", name: "fixed-skill", files: first });
    const again = await publish(market, { type: "spade-skill", name: "fixed-skill", files: first });
    expect(again.status).toBe(200);
    const other = sampleSkill("fixed-skill", { "notes.md": "Something else." });
    const reused = await publish(market, {
      type: "spade-skill",
      name: "fixed-skill",
      files: other,
    });
    expect(reused.status).toBe(409);

    const entry = (await (await market.fetch("/v1/entries/spade-skill/fixed-skill")).json()) as {
      versions: { version: string; hash: string }[];
    };
    expect(entry.versions).toHaveLength(1);
    const object = await market.fetch(`/v1/objects/${entry.versions[0]?.hash}`);
    const read = readArchive(new Uint8Array(await object.arrayBuffer()), typeLimits["spade-skill"]);
    expect(read.map((file) => file.path)).toEqual(["SKILL.md"]);
  });

  it("the signer can't list a version under a manifest naming other bytes", async () => {
    const files = sampleSkill("swapped-skill");
    expect(
      (await publish(market, { type: "spade-skill", name: "swapped-skill", files })).status,
    ).toBe(201);
    const publisher = await pendingPublisher(market, "spade-skill", "swapped-skill");
    const other = sampleSkill("swapped-skill", { "extra.md": "More." });
    const response = await put(market, "/v1/signer/versions/spade-skill/swapped-skill/1.0.0", {
      manifest: manifestFor(
        { type: "spade-skill", name: "swapped-skill", files: other },
        { publisher },
      ),
    });
    expect(response.status).toBe(422);
    expect(await indexNames()).not.toContain("spade-skill/swapped-skill");
  });

  it.each([
    ["no grant", undefined],
    ["a relay machine grant", relayGrant("acct_a")],
    ["a relay device grant", relayGrant("acct_a", "device")],
    ["a cloud grant", cloudGrant("acct_a")],
    ["something that isn't a grant", "not-a-grant"],
  ])("a publish with %s is refused", async (_label, grant) => {
    const params = new URLSearchParams({ version: "1.0.0", publisher: "tester" });
    const response = await market.fetch(`/v1/publish/suit/harbour-dusk/versions?${params}`, {
      method: "POST",
      headers: grant ? { authorization: `Bearer ${grant}` } : {},
      body: new Uint8Array(1024),
    });
    expect(response.status).toBe(401);
    expect(await pendingPublisher(market, "suit", "harbour-dusk")).toBeUndefined();
  });

  it("an entry belongs to the publisher who first published it", async () => {
    await publishSigned(market, { type: "suit", name: "harbour-dusk", files: sampleSuit() });
    const theirs = await publish(market, {
      type: "suit",
      name: "harbour-dusk",
      version: "1.0.1",
      files: sampleSuit(),
      account: "acct_b",
      publisher: "someone-else",
    });
    expect(theirs.status).toBe(403);
  });

  it("a publisher name is taken by the first account that publishes with it", async () => {
    const response = await publish(market, {
      type: "spade-skill",
      name: "name-clash",
      files: sampleSkill("name-clash"),
      account: "acct_c",
      publisher: "tester",
    });
    expect(response.status).toBe(409);
  });

  it("a first publish without a publisher name is refused with a problem", async () => {
    const response = await market.fetch(`/v1/publish/spade-skill/no-name/versions?version=1.0.0`, {
      method: "POST",
      headers: { authorization: `Bearer ${marketGrant("acct_d")}` },
      body: new Uint8Array(),
    });
    expect(response.status).toBe(422);
  });

  it("an archive over the market's limit is refused before it is read", async () => {
    const response = await publish(market, {
      type: "spade-skill",
      name: "huge",
      files: folder({ "SKILL.md": "x".repeat(41 * 1024 * 1024) }),
    });
    expect(response.status).toBe(413);
  });

  it("a publisher withdraws only their own version, and it waits for the signer", async () => {
    await publishSigned(market, {
      type: "spade-skill",
      name: "own-skill",
      files: sampleSkill("own-skill"),
    });
    const path = "/v1/publish/spade-skill/own-skill/versions/1.0.0/withdraw";
    const theirs = await market.fetch(path, {
      method: "POST",
      headers: { authorization: `Bearer ${marketGrant("acct_b")}` },
      body: JSON.stringify({ reason: "Not mine to pull." }),
    });
    expect(theirs.status).toBe(403);
    const mine = await market.fetch(path, {
      method: "POST",
      headers: { authorization: `Bearer ${marketGrant("acct_a")}` },
      body: JSON.stringify({ reason: "Broken on Linux." }),
    });
    expect(mine.status).toBe(202);
    const pending = (await (
      await market.fetch("/v1/signer/pending", { headers: asSigner })
    ).json()) as {
      withdrawals: { name: string; reason: string }[];
    };
    expect(pending.withdrawals).toEqual([
      expect.objectContaining({ name: "own-skill", reason: "Broken on Linux." }),
    ]);
  });
});
