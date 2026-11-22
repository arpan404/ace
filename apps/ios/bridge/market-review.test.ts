import "./test-host.ts";
import type {
  MarketEntrySummary,
  MarketInstalled,
  MarketReview,
  MarketReviewItem,
  MarketScanReport,
} from "@ace/protocol/marketplace";
import { afterEach, expect, test } from "vitest";
import { NativeMarket, NativeMarketRequest } from "./market.ts";
import { sheetFixture, until } from "./sheet-fixture.ts";

/*
 * An entry's page and its review on the phone, through the fake daemon's market: each type's
 * sections, Install held until the review is read, and the choices that reach the machine.
 */

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const summary = (type: string, name: string, extra: Partial<MarketEntrySummary> = {}) => ({
  source: "market",
  type,
  name,
  title: name,
  line: `${name} in one line`,
  categories: [],
  keywords: [],
  version: "1.0.0",
  reviewed: true,
  byAce: false,
  updated: 1,
  downloads: 3,
  supported: true,
  ...extra,
});

const scan: MarketScanReport = {
  format: "ace-market-scan",
  scanner: 1,
  verdict: "warn",
  checks: [],
  findings: [
    { check: "files", rule: "big-picture", level: "note", message: "Has a large picture" },
    { check: "scripts", rule: "download-exec", level: "warn", message: "Downloads and runs code" },
  ],
  runnable: true,
  truncated: false,
  read: { files: 2, textBytes: 100 },
};

const skillItems: MarketReviewItem[] = [
  {
    kind: "text",
    section: "",
    path: "SKILL.md",
    text: "# Triage",
    before: false,
    truncated: false,
  },
  {
    kind: "file",
    section: "",
    file: { path: "SKILL.md", bytes: 812, executable: false, flagged: false },
  },
  {
    kind: "file",
    section: "",
    file: { path: "run.sh", bytes: 90, executable: true, flagged: true },
  },
];

const pluginItems: MarketReviewItem[] = [
  {
    kind: "execution",
    section: "",
    execution: { kind: "stdio", name: "notes", command: "node", args: ["server.js"], env: {} },
  },
  {
    kind: "execution",
    section: "",
    execution: {
      kind: "remote",
      name: "search",
      type: "http",
      url: "https://x.dev/mcp",
      headers: {},
    },
  },
];

const botBody: MarketReview["body"] = {
  type: "spade-bot",
  botName: "Inbox",
  task: "You look after the person's inbox.",
  model: "capable",
  routines: [{ name: "Morning sort", instruction: "Sort it.", schedule: "weekdays at 8:00" }],
  notes: [],
  brings: [{ type: "spade-skill", name: "triage-mail", version: "1.0.0" }],
  needs: [
    {
      key: "connector:gmail",
      kind: "connector",
      label: "Gmail",
      why: "Reads mail.",
      required: true,
    },
    {
      key: "connector:calendar",
      kind: "connector",
      label: "Calendar",
      why: "Books time.",
      required: false,
    },
  ],
  spadeReady: true,
};

type Answer = Record<string, unknown> & { ok: boolean; message?: string; code?: string };
type Review = Record<string, unknown> & { id: string; hash: string };

async function market(installed: MarketInstalled[] = []) {
  const { daemon, client } = sheetFixture();
  daemon.seedServices({
    marketplace: {
      entries: [
        { summary: summary("suit", "harbour-dusk", { title: "Harbour dusk", byAce: true }) },
        {
          summary: summary("spade-skill", "triage-mail", { title: "Triage mail" }),
          review: { scan },
          items: skillItems,
        },
        {
          summary: summary("spade-plugin", "notes", { title: "Notes", reviewed: false }),
          items: pluginItems,
        },
        {
          summary: summary("spade-bot", "inbox", { title: "Inbox" }),
          review: { body: botBody },
        },
        {
          summary: summary("suit", "broken"),
          review: { blocked: "It fails ace's checks, so it can't be installed." },
        },
      ],
      installed,
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
  const prepare = async (type: string, name: string) =>
    (await ask({ op: "prepare", source: "market", type, name })).review as Review;
  const read = (review: Review) => ask({ op: "readReview", id: review.id });
  return { ask, prepare, read, daemon };
}

test("a skill's review shows its scan findings with their levels, its SKILL.md and its scripts", async () => {
  const { prepare, read } = await market();
  const review = await prepare("spade-skill", "triage-mail");
  expect(review).toMatchObject({
    heading: "Get Triage mail",
    action: "Get",
    byLine: "Skill · 1.0.0",
    reviewMark: "Reviewed by ace",
    signedText: "Signed by the Marketplace",
    findings: [
      { level: "warn", levelWord: "Warning", sentence: "Downloads and runs code." },
      { level: "note", levelWord: "Note", sentence: "Has a large picture." },
    ],
    standingSentence: "Install this from your computer.",
  });
  expect(review.facts).toEqual(
    expect.arrayContaining([
      "From store.acehq.dev, reviewed by ace.",
      "Teaches Spade's bots “triage-mail”: triage-mail in one line.",
    ]),
  );
  const page = await read(review);
  expect(page.rows).toEqual([
    expect.objectContaining({ kind: "text", title: "SKILL.md", text: "# Triage" }),
    expect.objectContaining({
      kind: "file",
      title: "SKILL.md",
      detail: "812 bytes",
      flagged: false,
    }),
    expect.objectContaining({
      kind: "file",
      title: "run.sh",
      detail: "90 bytes · A script or program",
      flagged: true,
    }),
  ]);
  expect(page.complete).toBe(true);
});

test("a plugin's review lists what it runs and where it reaches, asks for bots, and needs the person", async () => {
  const { prepare, read } = await market();
  const review = await prepare("spade-plugin", "notes");
  expect(review).toMatchObject({
    reviewMark: "Not reviewed by ace",
    reviewNote: "Read what it does before you install it.",
    plugin: { asksBots: true },
    standingSentence: "Install this from your computer.",
    choices: { bots: [], needs: {}, startRoutines: false },
  });
  expect((await read(review)).rows).toEqual([
    expect.objectContaining({ kind: "run", title: "Server notes", detail: "node server.js" }),
    expect.objectContaining({
      kind: "run",
      title: "Remote server search",
      detail: "https://x.dev/mcp",
    }),
  ]);
});

test("a bot's review shows its face, task, model, routines, what it brings and each need", async () => {
  const { prepare } = await market();
  const review = await prepare("spade-bot", "inbox");
  expect(review).toMatchObject({
    heading: "Get Inbox",
    bot: {
      face: { main: false, initial: "I", away: false, character: expect.any(Object) },
      task: "You look after the person's inbox.",
      modelWord: "Capable model",
      routines: [{ name: "Morning sort", when: "weekdays at 8:00" }],
      brings: ["Skill triage-mail 1.0.0"],
      needs: [
        {
          key: "connector:gmail",
          label: "Gmail",
          line: "Reads mail. Required.",
          required: true,
          offSentence: "Inbox can't work without Gmail.",
        },
        {
          key: "connector:calendar",
          label: "Calendar",
          line: "Books time. Optional.",
          required: false,
          offSentence: null,
        },
      ],
    },
    choices: {
      bots: [],
      needs: { "connector:gmail": true, "connector:calendar": false },
      startRoutines: false,
    },
  });
});

test("a Suit's review says it passes ace's checks; a blocked one says why and holds Install", async () => {
  const { ask, prepare, read, daemon } = await market();
  const suit = await prepare("suit", "harbour-dusk");
  expect(suit).toMatchObject({ suit: { passes: true, checkLine: "Passes ace's checks." } });
  const broken = await prepare("suit", "broken");
  expect(broken.blocked).toBe("It fails ace's checks, so it can't be installed.");
  await read(broken);
  expect(await ask({ op: "install", id: broken.id, hash: broken.hash })).toMatchObject({
    ok: false,
    message: "It fails ace's checks, so it can't be installed.",
    way: null,
  });
  expect(daemon.marketplace.accepted).toEqual([]);
});

test("Install isn't sent until every page of the review is read", async () => {
  const { ask, prepare, read, daemon } = await market();
  const review = await prepare("spade-skill", "triage-mail");
  expect(await ask({ op: "install", id: review.id, hash: review.hash })).toMatchObject({
    ok: false,
    code: "unread",
    message: "Read the whole review before you install it.",
  });
  expect(daemon.marketplace.accepted).toEqual([]);
  await read(review);
  expect(await ask({ op: "install", id: review.id, hash: review.hash })).toMatchObject({
    ok: true,
    installed: { name: "triage-mail" },
  });
});

test("Install is never sent with a hash other than the review's", async () => {
  const { ask, prepare, read, daemon } = await market();
  const review = await prepare("spade-skill", "triage-mail");
  await read(review);
  expect(await ask({ op: "install", id: review.id, hash: "f".repeat(64) })).toMatchObject({
    ok: false,
    code: "conflict",
    way: "reread",
  });
  expect(daemon.marketplace.accepted).toEqual([]);
  // Kept back on the phone, so the review it holds still installs with its own hash.
  expect(await ask({ op: "install", id: review.id, hash: review.hash })).toMatchObject({
    ok: true,
  });
});

test("a bot installed with an optional need left off is made without it, its routines paused", async () => {
  const { ask, prepare, read, daemon } = await market();
  const review = await prepare("spade-bot", "inbox");
  await read(review);
  const done = await ask({
    op: "install",
    id: review.id,
    hash: review.hash,
    // What the sheet sends: its switches, and a key the review never asked for.
    choices: { bots: ["bot-1"], needs: { "connector:gmail": true, "plugin:other": true } },
  });
  expect(done.ok).toBe(true);
  expect(daemon.marketplace.accepted.map((each) => each.choices)).toEqual([
    {
      bots: [],
      needs: { "connector:gmail": true, "connector:calendar": false },
      startRoutines: false,
    },
  ]);
});

test("a plugin goes only to the bots the person chose", async () => {
  const { ask, prepare, read, daemon } = await market();
  const review = await prepare("spade-plugin", "notes");
  await read(review);
  await ask({ op: "install", id: review.id, hash: review.hash, choices: { bots: ["bot-1"] } });
  expect(daemon.marketplace.accepted[0]?.choices.bots).toEqual(["bot-1"]);
});

test("an expired review is dropped and offers to read it again", async () => {
  const { ask, prepare, read } = await market();
  const review = await prepare("spade-skill", "triage-mail");
  await ask({ op: "cancel", id: review.id });
  expect(await read(review)).toMatchObject({ ok: false, code: "expired", way: "reread" });
  expect(await ask({ op: "install", id: review.id, hash: review.hash })).toMatchObject({
    ok: false,
    code: "expired",
    way: "reread",
  });
});

test("an install refused for another reason keeps the review, so Install can run again", async () => {
  const { ask, prepare, read, daemon } = await market();
  const review = await prepare("spade-skill", "triage-mail");
  await read(review);
  daemon.marketplace.refuseInstall = { op: "error", code: "busy", message: "busy" };
  expect(await ask({ op: "install", id: review.id, hash: review.hash })).toMatchObject({
    ok: false,
    way: "retry",
  });
  daemon.marketplace.refuseInstall = undefined;
  expect(await ask({ op: "install", id: review.id, hash: review.hash })).toMatchObject({
    ok: true,
  });
});

test("an installed Suit's page says where it is and asks before removing it", async () => {
  const { ask } = await market([
    {
      source: "market",
      type: "suit",
      name: "harbour-dusk",
      title: "Harbour dusk",
      version: "1.0.0",
      hash: "c".repeat(64),
      acceptedAt: 1,
      state: "on",
    },
  ]);
  const page = await ask({ op: "read", source: "market", type: "suit", name: "harbour-dusk" });
  expect(page.entry).toMatchObject({
    action: "installed",
    actionWord: "Installed",
    publisherMark: "By ace",
    reviewMark: "Reviewed by ace",
    sourceText: "store.acehq.dev",
    installedNote: "Wear it from ace on your computer.",
    removeQuestion: "Remove Harbour dusk?",
    removeLine: "The Suit comes off this machine.",
    turnOnWord: null,
    turnOnAsk: null,
  });
});

test("the entry page asks as Installed does: a bot package's remove keeps what it brought, a withdrawn install asks first", async () => {
  const { ask } = await market([
    {
      source: "market",
      type: "spade-bot",
      name: "inbox",
      title: "Inbox",
      version: "1.0.0",
      hash: "c".repeat(64),
      acceptedAt: 1,
      state: "withdrawn",
      reason: "Broken",
      target: "bot_1",
    },
  ]);
  const page = await ask({ op: "read", source: "market", type: "spade-bot", name: "inbox" });
  expect(page.entry).toMatchObject({
    removeQuestion: "Remove Inbox from Installed?",
    removeLine:
      "Inbox and the skills and plugins it brought stay yours. It stops getting updates from the Marketplace.",
    turnOnWord: "Turn back on",
    turnOnAsk: {
      question: "Turn Inbox back on?",
      detail:
        "Its publisher withdrew it: Broken. It runs again at your own risk, until ace turns it off the next time it reads the Marketplace.",
      confirm: "Turn back on anyway",
    },
    installedNote: null,
  });
});

test("an install refused for standing after its review was swept reads as expired, to review again", async () => {
  const { ask, prepare, read, daemon } = await market();
  const review = await prepare("spade-skill", "triage-mail");
  await read(review);
  daemon.marketplace.sweep(review.id);
  daemon.marketplace.refuseInstall = { op: "error", code: "reauth", message: "Sign in again" };
  expect(await ask({ op: "install", id: review.id, hash: review.hash })).toMatchObject({
    ok: false,
    code: "expired",
    way: "reread",
  });
});

test("an install refused for standing while its review is held keeps the way to confirm", async () => {
  const { ask, prepare, read, daemon } = await market();
  const review = await prepare("spade-skill", "triage-mail");
  await read(review);
  daemon.marketplace.refuseInstall = {
    op: "error",
    code: "reauth",
    message: "Confirm your identity to continue.",
  };
  expect(await ask({ op: "install", id: review.id, hash: review.hash })).toMatchObject({
    ok: false,
    code: "reauth",
    way: "confirm",
  });
});
