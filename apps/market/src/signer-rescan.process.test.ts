import { afterAll, beforeAll, expect, it } from "vitest";
import { signPending } from "@ace/marketplace/signer";
import { keySetOf, sampleSkill } from "@ace/marketplace/testing";
import { MarketQueueBody } from "@ace/protocol/marketplace";
import { asSigner, marketKey, publish, put, startMarket, type Market } from "./testing/harness.ts";
import { approve, blocklistBy, officialBy, signerIoOf } from "./testing/discover-harness.ts";

/*
 * `ace market sign` scans again before it signs (ADR 0173 §8, §9): against the real Worker, a
 * stored version the newest blocklist names is blocked, a warn nobody approved is held, an
 * official version is held unless approved, and only the rest is listed.
 */

let market: Market;
beforeAll(async () => {
  market = await startMarket();
});
afterAll(() => market.close());

let clock = 1_800_000_000_000;
const now = () => ++clock;
const trusted = keySetOf(marketKey);
const sign = () => signPending(signerIoOf(market), marketKey, now, trusted);
const state = async (name: string) =>
  (await market.db
    .prepare("SELECT state, listed, block_reason FROM versions WHERE name = ?1")
    .bind(name)
    .first<{ state: string; listed: number; block_reason: string | null }>()) ?? undefined;
const queue = async () =>
  MarketQueueBody.parse(
    await (await market.fetch("/v1/signer/queue", { headers: asSigner })).json(),
  );
/** A version stored waiting for the signer by an earlier Worker, before its scan held it. */
const storedEarlier = (name: string) =>
  market.db
    .prepare("UPDATE versions SET state = 'pending', approved = 0 WHERE name = ?1")
    .bind(name)
    .run();

it("blocks a stored version the newest blocklist names, and lists what passes", async () => {
  const bad = { type: "spade-skill" as const, name: "later-bad", files: sampleSkill("later-bad") };
  const good = {
    type: "spade-skill" as const,
    name: "still-good",
    files: sampleSkill("still-good"),
  };
  const published = (await (await publish(market, bad)).json()) as { hash: string };
  await publish(market, good);
  await approve(market, bad);
  await approve(market, good);
  // Maintainers learn the bytes are harmful after the Worker stored them.
  const blocklist = blocklistBy({
    issued: 10,
    hashes: [{ hash: published.hash, reason: "Sends the person's keys away" }],
    files: [],
    patterns: [],
  });
  expect((await put(market, "/v1/signer/blocklist", { blocklist })).status).toBe(200);

  const report = await sign();
  expect(report.blocked.map((item) => item.version)).toEqual(["spade-skill/later-bad@1.0.0"]);
  expect(report.blocked[0]?.reason).toContain("Sends the person's keys away");
  expect(report.signed).toEqual(["spade-skill/still-good@1.0.0"]);
  expect(await state("later-bad")).toMatchObject({ state: "blocked", listed: 0 });
  expect((await market.fetch("/v1/entries/spade-skill/later-bad/1.0.0")).status).toBe(404);
  expect(await state("still-good")).toMatchObject({ state: "listed", listed: 1 });
  // A maintainer's approval covers warns, never a block: the next run doesn't sign it either.
  expect((await sign()).signed).toEqual([]);
});

it("holds a warn nobody approved, with its findings in the queue, and signs it once approved", async () => {
  const files = sampleSkill("env-reader", {
    "scripts/setup.sh": "#!/bin/sh\nsource ./.env\necho ready\n",
  });
  const upload = { type: "spade-skill" as const, name: "env-reader", files };
  expect([200, 201]).toContain((await publish(market, upload)).status);
  await storedEarlier("env-reader");

  const report = await sign();
  expect(report.held.map((item) => item.version)).toEqual(["spade-skill/env-reader@1.0.0"]);
  expect(report.held[0]?.findings.join(" ")).toContain(".env");
  expect(await state("env-reader")).toMatchObject({ state: "held", listed: 0 });
  expect((await queue()).held.map((item) => item.name)).toContain("env-reader");

  await approve(market, upload);
  expect((await sign()).signed).toEqual(["spade-skill/env-reader@1.0.0"]);
  expect(await state("env-reader")).toMatchObject({ state: "listed", listed: 1 });
});

it("holds every version by the official publisher unless a maintainer approved it", async () => {
  const official = officialBy({
    issued: 10,
    publisher: { id: "pub_ace0000000000000000000", name: "ace" },
    accounts: ["acct_ace"],
  });
  expect((await put(market, "/v1/signer/official", { official })).status).toBe(200);
  const upload = {
    type: "spade-skill" as const,
    name: "ace-helper",
    files: sampleSkill("ace-helper"),
    account: "acct_ace",
  };
  expect([200, 201]).toContain((await publish(market, upload)).status);
  await storedEarlier("ace-helper");
  expect((await sign()).held.map((item) => item.version)).toEqual(["spade-skill/ace-helper@1.0.0"]);

  await approve(market, upload);
  expect((await sign()).signed).toEqual(["spade-skill/ace-helper@1.0.0"]);
});
