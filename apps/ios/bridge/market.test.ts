import "./test-host.ts";
import type { MarketEntrySummary, MarketInstalled } from "@ace/protocol/marketplace";
import { MarketErrorCode } from "@ace/protocol/marketplace";
import { afterEach, expect, test } from "vitest";
import type { z } from "zod";
import { ClientError } from "@ace/client";
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

/**
 * How a change's reply goes missing: `committed` sends it and loses the answer, `dropped` loses
 * it before the daemon sees it, and `gone` also fails every read after.
 */
type Loss = "committed" | "dropped" | "gone";
interface MarketOptions {
  lose?: { op: string; how: Loss };
}

async function market(options: MarketOptions = {}) {
  const { daemon, client } = sheetFixture();
  daemon.seedServices({
    marketplace: {
      entries: [
        listing("spade-skill", "triage-mail"),
        {
          ...listing("suit", "harbour-dusk", { title: "Harbour dusk", previews: ["a".repeat(64)] }),
          items: [
            {
              kind: "text",
              section: "Suit",
              path: "suit.json",
              before: false,
              truncated: false,
              text: JSON.stringify({
                format: 1,
                id: "harbour-dusk",
                name: "Harbour dusk",
                dark: { canvas: "#15171B", accent: "#E6DCCD" },
              }),
            },
          ],
        },
        {
          ...listing("spade-bot", "future", { supported: false }),
          review: {
            body: {
              type: "spade-bot",
              botName: "Future",
              task: "",
              model: "fast",
              routines: [],
              notes: [],
              brings: [],
              needs: [],
              spadeReady: true,
              face: { kind: "character", v: 1, body: "fox", pair: "mint", eyes: "sleepy" },
            },
          },
        },
        listing("spade-skill", "refused-one"),
        {
          ...listing("spade-skill", "scanned"),
          blocked: {
            format: "ace-market-scan",
            scanner: 1,
            verdict: "block",
            checks: [],
            findings: [
              {
                check: "scripts",
                rule: "download-exec",
                level: "block",
                message: "Pipes a download into a shell",
              },
            ],
            runnable: true,
            truncated: false,
            read: { files: 1, textBytes: 10 },
          },
        },
      ],
      refuse: { "spade-skill/refused-one": "Not signed by ace's market" },
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
  let lost = false;
  const owner = {
    get state() {
      return client.state;
    },
    request: (async (message: { operation: { op: string } }, wait: unknown) => {
      const loss = options.lose;
      if (loss && (lost || message.operation.op === loss.op)) {
        const first = !lost;
        lost = true;
        if (loss.how === "gone" && !first) throw new ClientError("offline");
        if (first && loss.how !== "dropped") await client.request(message as never, wait as never);
        if (first) throw new ClientError("timeout");
      }
      return client.request(message as never, wait as never);
    }) as typeof client.request,
  };
  const service = new NativeMarket(
    owner,
    () => 6_000,
    async () => {},
  );
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
    categories: [{ id: "mail", title: "Mail", countText: "5 entries" }],
    updatesText: "1 update",
  });
});

test("the phone receives a listing preview hash and the package artwork used on web", async () => {
  const { ask } = await market();
  expect(await ask({ op: "home" })).toMatchObject({
    featured: [{ name: "harbour-dusk", picture: "a".repeat(64) }],
  });
  expect(
    await ask({
      op: "look",
      source: "market",
      type: "suit",
      name: "harbour-dusk",
      version: "1.0.0",
    }),
  ).toMatchObject({ ok: true, dark: ["#15171B", "#E6DCCD"], light: [] });
  expect(
    await ask({
      op: "look",
      source: "market",
      type: "spade-bot",
      name: "future",
      version: "1.0.0",
    }),
  ).toMatchObject({ ok: true, face: { body: "fox", pair: "mint", eyes: "sleepy" } });
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
  blocked: ["ace's scan refused it. Fix what it found, then try again.", "computer"],
  suspended: ["Your publisher account is suspended.", null],
  quota: ["You've reached your publishing limit for now.", null],
  not_found: ["This entry isn't listed anymore.", null],
  invalid: [unfinished, null],
  refused: [unfinished, "computer"],
  forbidden: ["This device can't make changes to the Store.", "computer"],
  unavailable: ["The Store can't be reached right now.", "retry"],
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

test("an install whose reply was lost after the machine finished it reads as installed", async () => {
  const { ask } = await market({ lose: { op: "install", how: "committed" } });
  const prepared = await ask({
    op: "prepare",
    source: "market",
    type: "suit",
    name: "harbour-dusk",
  });
  const review = prepared.review as { id: string; hash: string };
  await ask({ op: "readReview", id: review.id });
  expect(await ask({ op: "install", id: review.id, hash: review.hash })).toMatchObject({
    ok: true,
    offline: false,
    installed: { type: "suit", name: "harbour-dusk" },
  });
});

test("an install whose reply was lost before it reached the machine says it didn't finish", async () => {
  const { ask } = await market({ lose: { op: "install", how: "dropped" } });
  const prepared = await ask({
    op: "prepare",
    source: "market",
    type: "suit",
    name: "harbour-dusk",
  });
  const review = prepared.review as { id: string; hash: string };
  await ask({ op: "readReview", id: review.id });
  expect(await ask({ op: "install", id: review.id, hash: review.hash })).toMatchObject({
    ok: false,
    code: "failed",
    message: "The install didn't finish, and nothing was installed.",
    way: "retry",
  });
});

test("a lost removal the machine can't be asked about is never called unchanged or retried", async () => {
  const { ask } = await market({ lose: { op: "remove", how: "gone" } });
  const answer = await ask({ op: "remove", type: "spade-skill", name: "aaa-notes" });
  expect(answer).toMatchObject({ ok: false, code: "unconfirmed", way: "reread" });
  expect(answer.message).not.toContain("Nothing was changed");
});

test("a lost removal the machine did make reads as removed", async () => {
  const { ask } = await market({ lose: { op: "remove", how: "committed" } });
  expect(await ask({ op: "remove", type: "spade-skill", name: "aaa-notes" })).toEqual({
    ok: true,
    offline: false,
    installed: null,
  });
});

test("an entry refused by ace's checks says which check, and sends the person to the computer", async () => {
  const { ask } = await market();
  expect(
    await ask({ op: "prepare", source: "market", type: "spade-skill", name: "refused-one" }),
  ).toMatchObject({
    ok: false,
    code: "refused",
    way: "computer",
    reason: "Not signed by ace's market.",
  });
});

test("an entry this device's scan blocks names what it found", async () => {
  const { ask } = await market();
  expect(
    await ask({ op: "prepare", source: "market", type: "spade-skill", name: "scanned" }),
  ).toMatchObject({
    ok: false,
    code: "blocked",
    way: "computer",
    reason: "Pipes a download into a shell.",
  });
});

test("turning a skill on for bots after a newer version landed asks to look again", () => {
  expect(refusalAnswer("conflict", "change", { op: "turnOnForBots" })).toMatchObject({
    message: "A newer version of this skill was installed. Look at it again, then turn it on.",
    way: "reread",
  });
});

const takes = (operation: Record<string, unknown>) =>
  NativeMarketRequest.safeParse({ type: "market.native", operation }).success;

test("a review of an organization's registry isn't taken from the phone", () => {
  const prepare = { op: "prepare", source: "market", type: "suit", name: "harbour-dusk" };
  expect(takes(prepare)).toBe(true);
  expect(takes({ ...prepare, registry: "acme" })).toBe(false);
  expect(takes({ ...prepare, trustKey: "A".repeat(43) })).toBe(false);
});

test("offline, only the most recent searches are still kept", async () => {
  const { ask, client } = await market();
  const first = await ask({ op: "search", query: "q0" });
  for (let n = 1; n <= 32; n++) await ask({ op: "search", query: `q${n}` });
  const latest = await ask({ op: "search", query: "q32" });
  await client.close();
  expect(await ask({ op: "search", query: "q32" })).toEqual({ ...latest, offline: true });
  expect(await ask({ op: "search", query: "q0" })).not.toEqual({ ...first, offline: true });
});

test("browse rows carry their button from what the machine has installed", async () => {
  const { ask } = await market();
  const buttonOf = async () =>
    ((await ask({ op: "home" })).featured as { id: string; action: { word: string | null } }[])
      .filter((row) => row.id === "market/suit/harbour-dusk")
      .map((row) => row.action.word);
  expect(await buttonOf()).toEqual(["Get"]);
  const prepared = await ask({
    op: "prepare",
    source: "market",
    type: "suit",
    name: "harbour-dusk",
  });
  const review = prepared.review as { id: string; hash: string };
  await ask({ op: "readReview", id: review.id });
  await ask({ op: "install", id: review.id, hash: review.hash });
  expect(await buttonOf()).toEqual(["Installed"]);
});

test("a catalog address that isn't https is refused on the phone, even with the machine away", async () => {
  const { ask, client } = await market();
  await client.close();
  for (const address of ["http://example.com/c.git", "git@host:x.git", "https://"])
    expect(await ask({ op: "addSource", address })).toEqual({
      ok: false,
      offline: false,
      code: "invalid",
      message: "That isn't a git catalog's https address.",
      way: null,
    });
});
