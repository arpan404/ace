import "./test-host.ts";
import type { MarketInstalled } from "@ace/protocol/marketplace";
import { afterEach, expect, test } from "vitest";
import { NativeMarket, NativeMarketRequest } from "./market.ts";
import { sheetFixture, until } from "./sheet-fixture.ts";
import type { PairedStanding } from "./socket.ts";

/*
 * The person-only market changes on the phone (spec items 14, 20 to 23), through the fake
 * daemon's market: turning a skill on for bots, and what a refusal for the person's standing
 * offers when this phone's socket proved it or never could.
 */

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const hash = "c".repeat(64);
const waiting: MarketInstalled = {
  source: "market",
  type: "spade-skill",
  name: "waiting",
  title: "Waiting",
  version: "1.0.0",
  hash,
  acceptedAt: 1,
  state: "on",
  botsApproved: false,
};
const notes = {
  source: "market",
  type: "spade-plugin",
  name: "notes",
  title: "Notes",
  line: "Notes in one line",
  categories: [],
  keywords: [],
  version: "1.0.0",
  reviewed: true,
  byAce: false,
  updated: 1,
  downloads: 3,
  supported: true,
};
const standingRefusal = {
  op: "error" as const,
  code: "reauth" as const,
  message: "Confirm your identity to continue.",
};

async function market(standing: PairedStanding | undefined) {
  const { daemon, client } = sheetFixture();
  daemon.seedServices({
    marketplace: {
      entries: [{ summary: notes }],
      installed: [waiting],
    },
  });
  close = () => client.close();
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  const sent: string[] = [];
  const owner = {
    get state() {
      return client.state;
    },
    request: ((message: { operation: { op: string } }, wait: unknown) => {
      sent.push(message.operation.op);
      return client.request(message as never, wait as never);
    }) as typeof client.request,
  };
  const facts = { standing };
  const service = new NativeMarket(
    owner,
    () => 6_000,
    async () => {},
    () => undefined,
    () => facts.standing,
  );
  const ask = async (operation: Record<string, unknown>, confirmed = false) =>
    (await service.answer(
      NativeMarketRequest.parse({
        type: "market.native",
        operation,
        ...(confirmed ? { confirmed: true } : {}),
      }),
      new AbortController().signal,
    )) as Record<string, unknown>;
  return { ask, daemon, sent, facts };
}

const turnOn = { op: "turnOnForBots", name: "waiting", hash };

test("turning a skill on for bots names its hash and answers the row the machine now holds", async () => {
  const { ask } = await market("proven");
  expect(await ask(turnOn)).toMatchObject({
    ok: true,
    installed: { name: "waiting", hash, waitsForBots: false, status: "Version 1.0.0" },
  });
});

test("turning on a version replaced since it was read asks to look again", async () => {
  const { ask } = await market("proven");
  expect(await ask({ ...turnOn, hash: "d".repeat(64) })).toMatchObject({
    ok: false,
    code: "conflict",
    message: "A newer version of this skill was installed. Look at it again, then turn it on.",
    way: "reread",
  });
});

test("a phone without the person's standing is sent to pair again, never to confirm", async () => {
  const { ask, daemon } = await market("missing");
  daemon.marketplace.refuseTurnOnForBots = standingRefusal;
  expect(await ask(turnOn)).toMatchObject({
    ok: false,
    code: "reauth",
    message: "Pair this iPhone again to turn this on here.",
    way: "pairAgain",
  });
});

test("an install refused for standing on a phone without it says to pair again to install here", async () => {
  const { ask, daemon } = await market("missing");
  const prepared = await ask({
    op: "prepare",
    source: "market",
    type: "spade-plugin",
    name: "notes",
  });
  const review = prepared.review as { id: string; hash: string };
  await ask({ op: "readReview", id: review.id, offset: 0 });
  daemon.marketplace.refuseInstall = standingRefusal;
  expect(await ask({ op: "install", id: review.id, hash: review.hash })).toMatchObject({
    ok: false,
    code: "reauth",
    message: "Pair this iPhone again to install here.",
    way: "pairAgain",
  });
});

test("a proven phone refused for standing offers Confirm it's you, and its retry turns it on", async () => {
  const { ask, daemon } = await market("proven");
  daemon.marketplace.refuseTurnOnForBots = standingRefusal;
  expect(await ask(turnOn)).toMatchObject({ ok: false, code: "reauth", way: "confirm" });
  daemon.marketplace.refuseTurnOnForBots = undefined;
  expect(await ask(turnOn, true)).toMatchObject({
    ok: true,
    installed: { name: "waiting", waitsForBots: false },
  });
});

test("a re-paired phone's Confirm it's you succeeds where the old pairing was sent to pair again", async () => {
  const { ask, daemon, facts } = await market("missing");
  daemon.marketplace.refuseTurnOnForBots = standingRefusal;
  expect(await ask(turnOn)).toMatchObject({ way: "pairAgain" });
  facts.standing = "proven";
  daemon.marketplace.refuseTurnOnForBots = undefined;
  expect(await ask(turnOn, true)).toMatchObject({ ok: true, installed: { waitsForBots: false } });
});

test("a refused Confirm it's you stops after one attempt and shows the sentence", async () => {
  const { ask, daemon, sent } = await market("proven");
  daemon.marketplace.refuseTurnOnForBots = standingRefusal;
  await ask(turnOn);
  sent.length = 0;
  expect(await ask(turnOn, true)).toEqual({
    ok: false,
    offline: false,
    code: "reauth",
    message: "Sign in again to do this.",
    way: null,
  });
  expect(sent).toEqual(["turnOnForBots"]);
});

test("a market that wants a person's grant for a phone change sends the person to the computer", async () => {
  const { ask, daemon } = await market("proven");
  daemon.marketplace.refuseTurnOnForBots = {
    op: "error",
    code: "person_grant",
    message: "The market needs the person",
  };
  expect(await ask(turnOn)).toMatchObject({ ok: false, code: "person_grant", way: "computer" });
});
