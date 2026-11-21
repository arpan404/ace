import type { MarketEntrySummary, MarketResult, MarketSource } from "@ace/protocol/marketplace";
import { readAtText } from "@ace/ui-core/market";
import { expect, test } from "vitest";
import { discoverAnswer, publisherAnswer, sourcesAnswer } from "./market-home.ts";
import { entryRow } from "./market-rows.ts";

/* Browse's answers as the phone draws them: shelves, sources and a publisher's page. */

type Result<T extends MarketResult["op"]> = Extract<MarketResult, { op: T }>;

const summary = (
  type: string,
  name: string,
  extra: Partial<MarketEntrySummary> = {},
): MarketEntrySummary => ({
  source: "market",
  type,
  name,
  title: name,
  line: `${name} in one line`,
  categories: [],
  keywords: [],
  reviewed: true,
  byAce: false,
  updated: 1,
  downloads: 0,
  supported: true,
  ...extra,
});

const discover = (extra: Partial<Result<"discover">["discover"]> = {}): Result<"discover"> => ({
  op: "discover",
  discover: {
    featured: [],
    trending: [],
    fresh: [],
    collections: [],
    publishers: [],
    ...extra,
  } as Result<"discover">["discover"],
});

const source = (extra: Partial<MarketSource> & Pick<MarketSource, "id">): MarketSource => ({
  kind: "git",
  address: "https://example.com/catalog.git",
  enabled: true,
  entries: 2,
  ...extra,
});

const now = Date.UTC(2026, 10, 21, 15, 0);

test("a row carries the link it is shared by, naming a git catalog's entry by its source", () => {
  expect(entryRow(summary("spade-skill", "triage-mail")).link).toBe(
    "ace://market?at=skill/triage-mail",
  );
  expect(entryRow(summary("spade-bot", "inbox", { source: "git:abc" })).link).toBe(
    "ace://market?at=bot/inbox@git:abc",
  );
  expect(entryRow(summary("suit", "harbour-dusk")).link).toBe("ace://market?at=suit/harbour-dusk");
});

test("discover says it is empty when every shelf is, so the home falls back to the device's listings", () => {
  expect(discoverAnswer(discover()).empty).toBe(true);
  expect(discoverAnswer(discover({ fresh: [summary("suit", "dusk")] })).empty).toBe(false);
  expect(discoverAnswer(discover({ hero: summary("suit", "dusk") })).empty).toBe(false);
});

test("a collection with no entries this build can list is left off the home", () => {
  const answer = discoverAnswer(
    discover({
      collections: [
        {
          id: "mail",
          title: "Mail",
          line: "For your inbox",
          entries: [summary("spade-skill", "a")],
        },
        { id: "empty", title: "Nothing yet", line: "", entries: [] },
      ],
    }),
  );
  expect(answer.collections.map((collection) => collection.id)).toEqual(["mail"]);
  expect(answer.empty).toBe(false);
});

test("a trending row says how its place moved this week", () => {
  const answer = discoverAnswer(
    discover({
      trending: [
        { entry: summary("suit", "a"), rank: 1, movement: { kind: "new" }, week: 9 },
        { entry: summary("suit", "b"), rank: 2, movement: { kind: "up", by: 3 }, week: 8 },
        { entry: summary("suit", "c"), rank: 3, movement: { kind: "down", by: 1 }, week: 7 },
        { entry: summary("suit", "d"), rank: 4, movement: { kind: "same" }, week: 6 },
      ],
    }),
  );
  expect(answer.trending.map((row) => [row.rank, row.movement])).toEqual([
    [1, "New"],
    [2, "Up 3"],
    [3, "Down 1"],
    [4, null],
  ]);
});

test("sources list the market first and only git catalogs can be removed", () => {
  const answer = sourcesAnswer(
    {
      op: "sources",
      sources: [
        source({ id: "git:abc", readAt: now - 60_000 }),
        source({ id: "market", kind: "market", address: "https://market.acehq.dev", readAt: now }),
      ],
    },
    { now },
  );
  expect(answer.sources.map((row) => [row.id, row.title, row.removable])).toEqual([
    ["market", "ace's marketplace", false],
    ["git:abc", "https://example.com/catalog.git", true],
  ]);
  expect(answer.stale).toBeNull();
});

test("with a source unreachable the page says when its listings were last read", () => {
  const readAt = now - 2 * 60 * 60_000;
  const answer = sourcesAnswer(
    {
      op: "sources",
      sources: [
        source({
          id: "market",
          kind: "market",
          address: "https://market.acehq.dev",
          readAt,
          problem: "The market didn't answer",
        }),
        source({ id: "git:abc", readAt: now }),
        source({ id: "git:off", enabled: false, readAt: 1, problem: "Off and failing" }),
      ],
    },
    { now },
  );
  expect(answer.stale).toBe(`Listings from ${readAtText(readAt, now)}`);
  expect(answer.sources[0]?.problem).toBe("The market didn't answer.");
});

test("a source never read says so, and an unreachable one never read adds no listings line", () => {
  const answer = sourcesAnswer(
    { op: "sources", sources: [source({ id: "git:new", problem: "Not found" })] },
    { now },
  );
  expect(answer.sources[0]?.listings).toBe("Not read yet");
  expect(answer.stale).toBeNull();
});

test("a publisher's pinned entries aren't listed twice", () => {
  const pinned = summary("spade-bot", "inbox");
  const answer = publisherAnswer({
    op: "publisher",
    page: {
      profile: { handle: "mira", displayName: "Mira", bio: "Makes bots", verified: true },
      downloads: 12,
      pinned: [pinned],
      entries: [pinned, summary("suit", "dusk")],
    },
  } as unknown as Result<"publisher">);
  expect(answer.pinned.map((row) => row.name)).toEqual(["inbox"]);
  expect(answer.rows.map((row) => row.name)).toEqual(["dusk"]);
  expect(answer.downloadsText).toBe("12 downloads");
});
