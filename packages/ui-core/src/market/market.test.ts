import type { MarketEntryDetail, MarketReview } from "@ace/protocol/marketplace";
import { expect, test } from "vitest";
import {
  andList,
  changeTitle,
  canDoSentences,
  entryAction,
  offeredUpdate,
  failureSentence,
  findingRows,
  findingSentences,
  flaggedWord,
  installBlock,
  MarketFailure,
  missingNeedsSentence,
  needCatalogue,
  needDefaults,
  replacesLine,
  reviewFromLine,
  reviewHeading,
  runDetail,
  runTitle,
  sizeText,
  typeWord,
} from "./index.ts";

/* The marketplace's shared words, as the web and the phone both say them. */

const entry = (extra: Partial<MarketEntryDetail> = {}): MarketEntryDetail => ({
  summary: {
    source: "market",
    type: "spade-skill",
    name: "triage-mail",
    title: "Triage mail",
    line: "Sorts your inbox",
    categories: [],
    keywords: [],
    reviewed: true,
    byAce: false,
    updated: 1,
    downloads: 0,
    supported: true,
  },
  description: "",
  versions: [],
  ...extra,
});

const installed = (update?: string) => ({
  source: "market",
  type: "spade-skill" as const,
  name: "triage-mail",
  title: "Triage mail",
  version: "1.0.0",
  hash: "a".repeat(64),
  acceptedAt: 1,
  state: "on" as const,
  ...(update ? { update } : {}),
});

test("a type reads as its word, and an unknown type as its own name", () => {
  expect(typeWord("spade-bot")).toBe("Bot");
  expect(typeWord("suit")).toBe("Suit");
  expect(typeWord("widget")).toBe("widget");
});

test("an entry this ace can't install says it needs a newer ace and offers nothing", () => {
  const unsupported = entry({ summary: { ...entry().summary, supported: false } });
  expect(installBlock(unsupported)).toBe("Needs a newer ace.");
  expect(entryAction(unsupported)).toBe("none");
});

test("a withdrawn latest version says its publisher's reason as a sentence", () => {
  const withdrawn = entry({
    versions: [{ version: "1.0.0", published: 1, hash: "b".repeat(64), withdrawn: "Broken" }],
  } as Partial<MarketEntryDetail>);
  expect(installBlock(withdrawn)).toBe("Withdrawn by its publisher: Broken.");
});

test("the entry's action is Get, Update or Installed by what this machine holds", () => {
  expect(entryAction(entry())).toBe("install");
  expect(entryAction(entry({ installed: installed() }))).toBe("installed");
  expect(entryAction(entry({ installed: installed("1.1.0") }))).toBe("update");
});

test("an update accepted while its bot works isn't offered again until a newer one comes", () => {
  const held = { ...installed("1.1.0"), held: { version: "1.1.0" } };
  expect(offeredUpdate(held)).toBeUndefined();
  expect(entryAction(entry({ installed: held }))).toBe("installed");
  expect(offeredUpdate({ ...installed("1.2.0"), held: { version: "1.1.0" } })).toBe("1.2.0");
  expect(offeredUpdate(installed("1.1.0"))).toBe("1.1.0");
  expect(offeredUpdate(installed())).toBeUndefined();
});

test.each([
  ["unavailable", "read", "The Store can't be reached right now."],
  ["not_found", "remove", "It isn't installed anymore."],
  ["not_found", "read", "This entry isn't listed anymore."],
  ["invalid", "add", "That isn't a git catalog's https address."],
  ["refused", "review", "ace refused this entry: it didn't pass ace's checks."],
  ["expired", "install", "This review expired. Review it again."],
  ["conflict", "install", "The entry changed since its review. Review it again."],
  ["busy", "install", "Another install is running. Try again in a moment."],
  ["reauth", "install", "Sign in again to do this."],
  ["failed", "install", "The install didn't finish, and nothing was installed."],
] as const)("a %s refusal while doing %s reads as one sentence", (code, step, words) => {
  expect(failureSentence(new MarketFailure(code), step)).toBe(words);
});

test("anything but a market refusal reads as what was being done failing", () => {
  expect(failureSentence(new Error("socket closed"), "remove")).toBe("It couldn't be removed.");
});

test("a scan's findings read blocks first, each a sentence", () => {
  expect(
    findingSentences({
      verdict: "block",
      findings: [
        { rule: "a", level: "note", message: "Has a picture" },
        { rule: "b", level: "block", message: "Runs curl | sh" },
      ],
    } as never),
  ).toEqual(["Runs curl | sh.", "Has a picture."]);
  expect(findingSentences(undefined)).toEqual([]);
});

test("a recipe's needs start on when required and off when optional", () => {
  expect(
    needDefaults([
      { key: "connector:gmail", required: true },
      { key: "plugin:notes", required: false },
    ] as never),
  ).toEqual({ "connector:gmail": true, "plugin:notes": false });
  expect(needCatalogue("connector:gmail")).toBe("gmail");
  expect(needCatalogue("connector:https://x.dev/mcp")).toBeUndefined();
});

test("a skill's review says what it teaches and whether it brings scripts", () => {
  const review = {
    body: {
      type: "spade-skill",
      skillName: "triage",
      description: "Sorts mail",
      files: 3,
      flagged: 1,
    },
  } as unknown as MarketReview;
  expect(canDoSentences(review)).toEqual([
    "Teaches Spade's bots “triage”: Sorts mail.",
    "3 files, 1 of them scripts or programs a bot can run under its gate.",
  ]);
});

test("a bot's review names its routines as paused", () => {
  const review = {
    body: { type: "spade-bot", botName: "Inbox", model: "fast", routines: [{}, {}], needs: [] },
  } as unknown as MarketReview;
  expect(canDoSentences(review).slice(0, 2)).toEqual([
    "Makes a new bot, Inbox, on your fast model.",
    "Has 2 routines, paused until you start them.",
  ]);
});

test("sizes, lists and flagged files read in plain words", () => {
  expect(sizeText(812)).toBe("812 bytes");
  expect(sizeText(4300)).toBe("4.2 KB");
  expect(andList(["A", "B", "C"])).toBe("A, B and C");
  expect(flaggedWord({ path: "run.sh", executable: true, flagged: true })).toBe(
    "A script or program",
  );
  expect(flaggedWord({ path: "font.woff2", executable: false, flagged: true })).toBe("Font");
});

test("a scan's findings keep their level, in a word, blocks first", () => {
  expect(
    findingRows({
      verdict: "warn",
      findings: [
        { rule: "a", level: "note", message: "Has a picture" },
        { rule: "b", level: "warn", message: "Reaches api.example.com" },
      ],
    } as never),
  ).toEqual([
    { level: "warn", levelWord: "Warning", sentence: "Reaches api.example.com." },
    { level: "note", levelWord: "Note", sentence: "Has a picture." },
  ]);
});

const reviewOf = (extra: Record<string, unknown>, body: Record<string, unknown> = {}) =>
  ({
    title: "Inbox",
    version: "1.1.0",
    reviewed: false,
    byAce: false,
    body: { type: "spade-bot", ...body },
    ...extra,
  }) as unknown as MarketReview;

test("a review is titled by what Install does: get, update or roll back", () => {
  expect(reviewHeading(reviewOf({}))).toBe("Get Inbox");
  expect(reviewHeading(reviewOf({ updates: "1.0.0" }))).toBe("Update Inbox");
  expect(reviewHeading(reviewOf({ updates: "1.2.0" }, { update: { rollback: true } }))).toBe(
    "Roll back Inbox",
  );
});

test("a review says where it is from and what it replaces", () => {
  expect(reviewFromLine(reviewOf({ reviewed: true }))).toBe(
    "From store.acehq.dev, reviewed by ace.",
  );
  expect(reviewFromLine(reviewOf({ from: "https://git.example.com/cat" }))).toBe(
    "From git.example.com/cat.",
  );
  expect(replacesLine(reviewOf({}))).toBeUndefined();
  expect(replacesLine(reviewOf({ updates: "1.0.0" }))).toBe(
    "Replaces version 1.0.0, which stays until you install.",
  );
});

test("Install waits with a sentence naming each required app left off", () => {
  expect(missingNeedsSentence("Inbox", [])).toBeUndefined();
  expect(missingNeedsSentence("Inbox", ["Gmail", "Slack"])).toBe(
    "Inbox can't work without Gmail and Slack.",
  );
});

test("a plugin's runs and an update's changes read as rows", () => {
  expect(runTitle({ kind: "stdio", name: "notes", command: "node", args: ["s.js"] } as never)).toBe(
    "Server notes",
  );
  expect(
    runDetail({ kind: "stdio", name: "notes", command: "node", args: ["s.js"] } as never),
  ).toBe("node s.js");
  expect(runDetail({ kind: "remote", name: "search", url: "https://x.dev/mcp" } as never)).toBe(
    "https://x.dev/mcp",
  );
  expect(changeTitle({ change: "added", path: "run.sh" })).toBe("Added run.sh");
});
