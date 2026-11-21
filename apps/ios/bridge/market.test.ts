import "./test-host.ts";
import type { MarketEntrySummary, MarketInstalled } from "@ace/protocol/marketplace";
import { MarketErrorCode } from "@ace/protocol/marketplace";
import { afterEach, expect, test } from "vitest";
import type { z } from "zod";
import { NativeMarket, NativeMarketRequest, refusalAnswer } from "./market.ts";
import { sheetFixture, until } from "./sheet-fixture.ts";

/* The phone's marketplace through the paired daemon, on the fake daemon's market. */

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const listing = (type: string, name: string, extra: Partial<MarketEntrySummary> = {}) => ({
  summary: {
    source: "market",
    type,
    name,
    title: name,
    line: `${name} in one line`,
    categories: ["mail"],
    keywords: [],
    version: "1.0.0",
    reviewed: true,
    byAce: false,
    updated: 1,
    downloads: 3,
    supported: true,
    ...extra,
  },
});
const install = (name: string, extra: Partial<MarketInstalled> = {}): MarketInstalled => ({
  source: "market",
  type: "spade-skill",
  name,
  title: name,
  version: "1.0.0",
  hash: "c".repeat(64),
  acceptedAt: 1,
  state: "on",
  ...extra,
});

type Answer = Record<string, unknown> & { ok: boolean; offline?: boolean; message?: string };

async function market() {
  const { daemon, client } = sheetFixture();
  daemon.seedServices({
    marketplace: {
      entries: [
        listing("spade-skill", "triage-mail"),
        listing("suit", "harbour-dusk", { title: "Harbour dusk" }),
        listing("spade-bot", "future", { supported: false }),
      ],
      featured: [{ type: "suit", name: "harbour-dusk" }],
      categories: [{ id: "mail", title: "Mail" }],
      installed: [
        install("aaa-notes"),
        install("zzz-digest", { update: "1.1.0" }),
        install("waiting", { botsApproved: false }),
      ],
      readAt: 5_000,
    },
  });
  close = () => client.close();
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  const service = new NativeMarket(client, () => 6_000);
  const ask = async (operation: Record<string, unknown>) =>
    (await service.answer(
      NativeMarketRequest.parse({ type: "market.native", operation }),
      new AbortController().signal,
    )) as Answer;
  return { ask, client, daemon };
}

test("the home lists featured rows with their words and says how many updates wait", async () => {
  const { ask } = await market();
  expect(await ask({ op: "home" })).toMatchObject({
    ok: true,
    offline: false,
    featured: [{ id: "market/suit/harbour-dusk", title: "Harbour dusk", typeWord: "Suit" }],
    categories: [{ id: "mail", title: "Mail", countText: "3 entries" }],
    updatesText: "1 update",
  });
});

test("search answers rows and when the listings were last read", async () => {
  const { ask } = await market();
  const found = await ask({ op: "search", query: "triage" });
  expect(found).toMatchObject({ ok: true, totalText: "1 result" });
  expect(found.rows).toEqual([expect.objectContaining({ name: "triage-mail", typeWord: "Skill" })]);
  expect(found.listings).toMatch(/^Listings from /);
});

test("an entry this build can't install reads 'Needs a newer ace' and offers no Get", async () => {
  const { ask } = await market();
  const future = await ask({ op: "read", source: "market", type: "spade-bot", name: "future" });
  expect(future.entry).toMatchObject({
    action: "none",
    actionWord: null,
    block: "Needs a newer ace.",
  });
  const skill = await ask({
    op: "read",
    source: "market",
    type: "spade-skill",
    name: "triage-mail",
  });
  expect(skill.entry).toMatchObject({
    action: "install",
    actionWord: "Get",
    downloadsText: "3 downloads",
  });
});

test("a review says what the entry can do, and installing it lands an installed row", async () => {
  const { ask } = await market();
  const prepared = await ask({
    op: "prepare",
    source: "market",
    type: "suit",
    name: "harbour-dusk",
  });
  const review = prepared.review as {
    id: string;
    hash: string;
    canDo: string[];
    reviewMark: string;
  };
  expect(review.canDo[0]).toBe("Passes ace's checks.");
  expect(review.reviewMark).toBe("Reviewed by ace");
  expect(await ask({ op: "readReview", id: review.id })).toMatchObject({
    ok: true,
    nextOffset: null,
  });
  expect(await ask({ op: "install", id: review.id, hash: review.hash })).toMatchObject({
    ok: true,
    installed: { type: "suit", name: "harbour-dusk", typeWord: "Suit" },
  });
});

test("Installed lists updates first, and a skill waiting for the person says so", async () => {
  const { ask } = await market();
  const answer = await ask({ op: "installed" });
  const rows = answer.rows as { name: string; status: string }[];
  expect(rows.map((row) => row.name)).toEqual(["zzz-digest", "aaa-notes", "waiting"]);
  expect(rows[0]?.status).toBe("Update to 1.1.0");
  expect(rows[2]?.status).toBe("Installed · Turn on for your bots");
  expect(answer.updatesText).toBe("1 update");
});

test("turning a waiting skill on for bots answers its row turned on", async () => {
  const { ask } = await market();
  expect(await ask({ op: "turnOnForBots", name: "waiting", hash: "c".repeat(64) })).toMatchObject({
    ok: true,
    installed: { name: "waiting", waitsForBots: false, status: "Version 1.0.0" },
  });
});

test("a refusal reads as its sentence, never as the daemon's own message", async () => {
  const { ask } = await market();
  expect(await ask({ op: "remove", type: "suit", name: "nothing" })).toEqual({
    ok: false,
    offline: false,
    code: "not_found",
    message: "It isn't installed anymore.",
    way: null,
  });
  expect(await ask({ op: "addSource", address: "git@host:x.git" })).toMatchObject({
    ok: false,
    message: "That isn't a git catalog's https address.",
  });
});

const unfinished = "The install didn't finish, and nothing was installed.";
const refusals: Record<z.infer<typeof MarketErrorCode>, [string, string | null]> = {
  signed_out: ["Sign in to publish.", null],
  reauth: ["Sign in again to do this.", "confirm"],
  blocked: ["ace's scan refused it. Fix what it found, then try again.", null],
  suspended: ["Your publisher account is suspended.", null],
  quota: ["You've reached your publishing limit for now.", null],
  not_found: ["This entry isn't listed anymore.", null],
  invalid: [unfinished, null],
  refused: [unfinished, null],
  forbidden: ["This device can't make changes to the marketplace.", "computer"],
  unavailable: ["The marketplace can't be reached right now.", "retry"],
  conflict: ["The entry changed since its review. Review it again.", "reread"],
  expired: ["This review expired. Review it again.", "reread"],
  busy: ["Another install is running. Try again in a moment.", "retry"],
  failed: [unfinished, "retry"],
  person_only: [unfinished, "confirm"],
  person_grant: [unfinished, "confirm"],
  not_member: [unfinished, null],
  registry_trust: [unfinished, null],
};
test.each(MarketErrorCode.options)(
  "an install refused with %s reads as its sentence and way out",
  (code) => {
    const [message, way] = refusals[code];
    expect(refusalAnswer(code, "install")).toEqual({
      ok: false,
      offline: false,
      code,
      message,
      way,
    });
  },
);

test("with the machine unreachable, a read answers what was kept, marked offline", async () => {
  const { ask, client } = await market();
  const online = await ask({ op: "home" });
  await client.close();
  const offline = await ask({ op: "home" });
  expect(offline).toEqual({ ...online, offline: true });
  expect(await ask({ op: "installed" })).toMatchObject({ ok: false, offline: true });
  expect(await ask({ op: "remove", type: "spade-skill", name: "aaa-notes" })).toEqual({
    ok: false,
    offline: true,
    code: "offline",
    message: "Your machine is offline. Nothing was changed.",
    way: "retry",
  });
});

test("only the v1 operations are taken from the phone", () => {
  expect(
    NativeMarketRequest.safeParse({ type: "market.native", operation: { op: "home" } }).success,
  ).toBe(true);
  expect(
    NativeMarketRequest.safeParse({ type: "market.native", operation: { op: "spadeSkills" } })
      .success,
  ).toBe(false);
});
