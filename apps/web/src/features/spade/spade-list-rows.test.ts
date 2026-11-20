import { parseSpadeAgentValue, parseSpadeGroupValue } from "@ace/ui-core/spade-chat";
import { expect, test } from "vitest";
import {
  holdSpadeOrder,
  searchSpadeList,
  spadeEntryKey,
  spadeFlatEntries,
  spadeBotRow,
  spadeListEntries,
  spadeNeedsYouCount,
  splitPinned,
} from "./spade-list-rows.ts";
import type { RosterGroup } from "./use-spade-groups.ts";
import type { RosterBot } from "./use-spade-roster.ts";

const here = { key: "primary", name: "This Mac", primary: true };

/** A bot as Spade sends it, read through the same parser the roster uses. */
function bot(fields: Record<string, unknown>, place: Partial<RosterBot> = {}): RosterBot {
  const agent = parseSpadeAgentValue({
    conversation: `c-${String(fields.id)}`,
    model: "e/m",
    ...fields,
  });
  if (!agent) throw new Error("unreadable agent");
  return { ...agent, machine: here, away: false, unavailable: false, ...place };
}

function group(fields: Record<string, unknown>): RosterGroup {
  const parsed = parseSpadeGroupValue({
    conversation: `g-${String(fields.id)}`,
    lead: { agent: "main", name: "Spade" },
    members: [
      { agent: "main", name: "Spade" },
      { agent: "learning", name: "Learning" },
    ],
    ...fields,
  });
  if (!parsed) throw new Error("unreadable group");
  return { ...parsed, machine: here, host: "h", away: false, unavailable: false };
}

const row = (fields: Record<string, unknown>, place?: Partial<RosterBot>) =>
  spadeBotRow(bot({ id: "b", name: "B", ...fields }, place));

const said = (text: string, from = "agent") => ({ from, text, at: 1, from_agent: null });

test("the list puts Spade first as an ordinary row, then orders needs you, working, failed, unseen, then the rest by latest", () => {
  const bots = [
    bot({ id: "main", kind: "main", name: "Spade", last_activity: 99 }),
    bot({ id: "old", name: "Old", last_activity: 1, last_message: said("bye") }),
    bot({ id: "new", name: "New", last_activity: 50, last_message: said("hi") }),
    bot({ id: "seen-not", name: "Research", last_activity: 2, unseen: true }),
    bot({ id: "trips", name: "Trips", last_activity: 3, problem: "Codex is signed out." }),
    bot({ id: "inbox", name: "Inbox", last_activity: 4, state: "working", status: "Reading" }),
    bot({ id: "gh", name: "Github", last_activity: 0, state: "waiting", waiting_for: "question" }),
  ];
  const groups = [
    group({ id: "study", name: "Study", last_activity: 10 }),
    group({ id: "drafts", name: "Drafts", last_activity: 1, unseen: true }),
  ];
  expect(
    spadeListEntries(bots, groups).map((entry) =>
      entry.kind === "bot" ? entry.bot.name : entry.group.name,
    ),
  ).toEqual(["Spade", "Github", "Inbox", "Trips", "Research", "Drafts", "New", "Study", "Old"]);
});

test("each row's state and line follow the row-state table", () => {
  expect(row({ state: "waiting", waiting_for: "question" })).toEqual({
    state: "needs-you",
    line: "Asked you a question",
  });
  expect(row({ state: "working", status: "Reading 14 new emails" })).toEqual({
    state: "working",
    line: "Reading 14 new emails",
  });
  expect(row({ problem: "Codex is signed out. Sign in to it in ace, then send again." })).toEqual({
    state: "failed",
    line: "Sign in to Codex to go on",
  });
  expect(row({ unseen: true, last_message: said("Found it.") })).toEqual({
    state: "unseen",
    line: "Found it.",
  });
  expect(row({ last_message: said("Yo") })).toEqual({ state: "rest", line: "Yo" });
  expect(row({ last_message: said("Water the tomatoes", "person") })).toEqual({
    state: "rest",
    line: "You: Water the tomatoes",
  });
  expect(row({ state: "working" }, { unavailable: true })).toEqual({
    state: "off",
    line: "Off on this machine",
  });
  expect(
    row({}, { away: true, machine: { key: "studio", name: "Studio Mac", primary: false } }),
  ).toEqual({ state: "off", line: "Studio Mac is offline" });
});

test("search finds conversations by name, members and their words", () => {
  const entries = spadeListEntries(
    [
      bot({ id: "garden", name: "Garden", last_message: said("Water the tomatoes", "person") }),
      bot({ id: "inbox", name: "Inbox" }),
    ],
    [group({ id: "study", name: "Bayes nets" })],
  );
  const names = (query: string) =>
    searchSpadeList(entries, query).map((entry) =>
      entry.kind === "bot" ? entry.bot.name : entry.group.name,
    );
  expect(names("tomatoes")).toEqual(["Garden"]);
  expect(names(" INB ")).toEqual(["Inbox"]);
  expect(names("learning")).toEqual(["Bayes nets"]);
  expect(names("zz")).toEqual([]);
  expect(names("")).toHaveLength(3);
});

test("the rail counts what waits on the person, groups included, and nothing that's off", () => {
  const bots = [
    bot({ id: "a", name: "A", state: "waiting" }),
    bot({ id: "b", name: "B", state: "waiting" }, { away: true }),
    bot({ id: "c", name: "C", problem: "Codex is signed out." }),
  ];
  expect(spadeNeedsYouCount(bots, [group({ id: "g", name: "G", state: "waiting" })])).toBe(2);
});

test("pinned conversations leave the rows and read oldest pin first, but Spade never leaves the first row", () => {
  const entries = spadeListEntries(
    [
      bot({ id: "main", kind: "main", name: "Spade" }),
      bot({ id: "a", name: "Atlas", last_activity: 3, pinned_at: 200 }),
      bot({ id: "b", name: "Bolt", last_activity: 2 }),
    ],
    [group({ id: "g", name: "Crew", last_activity: 1, pinned_at: 100 })],
  );
  const name = (entry: (typeof entries)[number]) =>
    entry.kind === "bot" ? entry.bot.name : entry.group.name;
  const { pinned, rest } = splitPinned(entries);
  expect(pinned.map(name)).toEqual(["Crew", "Atlas"]);
  expect(rest.map(name)).toEqual(["Spade", "Bolt"]);
  const spadePinned = splitPinned(
    spadeListEntries([bot({ id: "main", kind: "main", name: "Spade", pinned_at: 5 })], []),
  );
  // Even a Spade pinned in an older build stays the first row and is not in the strip.
  expect(spadePinned.pinned).toEqual([]);
  expect(spadePinned.rest.map(name)).toEqual(["Spade"]);
});

const maker = { id: "gh", name: "Github watcher" };
const family = () => [
  bot({
    id: "gh",
    name: "Github watcher",
    last_activity: 5,
    state: "working",
    status: "Waiting on 2 workers",
  }),
  bot({
    id: "lark",
    name: "Linux repro",
    last_activity: 4,
    state: "working",
    status: "Running tests",
    parent: maker,
  }),
  bot({
    id: "otter",
    name: "Changelog",
    last_activity: 3,
    last_message: said("Drafted"),
    parent: maker,
  }),
  bot({ id: "inbox", name: "Inbox", last_activity: 1, state: "working", status: "Reading" }),
];
const shape = (entries: ReturnType<typeof spadeListEntries>) =>
  entries.map((entry) => `${"bot" in entry ? entry.bot.id : entry.group.id}:${entry.depth}`);

test("workers nest under their maker while the maker or one of its workers is open", () => {
  expect(shape(spadeListEntries(family(), [], "gh"))).toEqual([
    "gh:0",
    "lark:1",
    "otter:1",
    "inbox:0",
  ]);
  expect(shape(spadeListEntries(family(), [], "otter"))).toEqual([
    "gh:0",
    "lark:1",
    "otter:1",
    "inbox:0",
  ]);
});

test("a folded family is one row, but a worker that needs you or failed stays raised under its maker", () => {
  expect(shape(spadeListEntries(family(), [], "inbox"))).toEqual(["gh:0", "inbox:0"]);
  const bots = family();
  bots[2] = bot({
    id: "otter",
    name: "Changelog",
    state: "waiting",
    waiting_for: "question",
    parent: maker,
  });
  bots[1] = bot({
    id: "lark",
    name: "Linux repro",
    problem: "Codex is signed out.",
    parent: maker,
  });
  const entries = spadeListEntries(bots, [], undefined);
  expect(shape(entries)).toEqual(["gh:0", "otter:1", "lark:1", "inbox:0"]);
  expect(entries[1]?.row).toMatchObject({ state: "needs-you" });
  expect(entries[2]?.row).toMatchObject({ state: "failed" });
});

const lark = (entries: ReturnType<typeof spadeListEntries>) =>
  entries.find((entry) => entry.kind === "bot" && entry.bot.id === "lark");

test("a nested worker's row reads what the check found, as it does in the flat list", () => {
  const bots = family();
  bots[1] = bot({
    id: "lark",
    name: "Linux repro",
    last_activity: 4,
    state: "working",
    parent: maker,
    task_progress: { state: "not_yet", items_total: 3, items_closed: 2, items_verified: 1 },
  });
  const missing = new Map([["primary/lark", "Linux CI still fails"]]);
  const nested = lark(spadeListEntries(bots, [], "gh", missing));
  expect(nested).toMatchObject({ depth: 1, row: { line: "Not yet: Linux CI still fails" } });
  expect(lark(spadeFlatEntries(bots, [], missing))?.row.line).toBe("Not yet: Linux CI still fails");
});

test("a worker whose maker isn't listed is an ordinary bot, and the same id on another machine isn't its maker", () => {
  const other = { key: "m2", name: "Linux box", primary: false };
  const bots = [
    bot({ id: "gh", name: "Github watcher" }, { machine: other }),
    bot({ id: "lark", name: "Linux repro", parent: maker }),
  ];
  expect(shape(spadeListEntries(bots, [], "lark"))).toContain("lark:0");
});

test("the search and the pin strip still reach a worker while its family is folded", () => {
  const bots = family();
  bots[1] = bot({ id: "lark", name: "Linux repro", pinned_at: 9, parent: maker });
  const all = spadeFlatEntries(bots, []);
  const nested = spadeListEntries(bots, [], undefined);
  expect(
    searchSpadeList(all, "linux").map((entry) => ("bot" in entry ? entry.bot.id : "")),
  ).toEqual(["lark"]);
  const { pinned, rest } = splitPinned(nested, all);
  expect(pinned.map((entry) => ("bot" in entry ? entry.bot.id : ""))).toEqual(["lark"]);
  expect(shape(rest)).toEqual(["gh:0", "inbox:0"]);
});

test("a worker's row keeps its own state when its maker is pinned", () => {
  const bots = family();
  bots[0] = bot({
    id: "gh",
    name: "Github watcher",
    pinned_at: 9,
    last_activity: 5,
    state: "working",
  });
  const { rest } = splitPinned(spadeListEntries(bots, [], "gh"), spadeFlatEntries(bots, []));
  expect(shape(rest)).toEqual(["lark:0", "otter:0", "inbox:0"]);
  expect(rest[0]?.row.state).toBe("working");
});

const names = (entries: ReturnType<typeof spadeListEntries>) =>
  entries.map((entry) => (entry.kind === "bot" ? entry.bot.name : entry.group.name));

test("while the pointer holds the list, a row that turns busy stays in its place, still current, and a new one comes first", () => {
  const before = spadeListEntries(
    [
      bot({ id: "a", name: "Alpha", last_activity: 3 }),
      bot({ id: "b", name: "Beta", last_activity: 2 }),
      bot({ id: "c", name: "Gamma", last_activity: 1 }),
    ],
    [],
  );
  const held = before.map(spadeEntryKey);
  // Gamma starts working, which puts it first; Delta is new.
  const after = spadeListEntries(
    [
      bot({ id: "a", name: "Alpha", last_activity: 3 }),
      bot({ id: "b", name: "Beta", last_activity: 2 }),
      bot({ id: "c", name: "Gamma", last_activity: 4, state: "working", status: "Reading" }),
      bot({ id: "d", name: "Delta", last_activity: 5 }),
    ],
    [],
  );
  expect(names(after)).toEqual(["Gamma", "Delta", "Alpha", "Beta"]);
  const shown = holdSpadeOrder(after, held);
  expect(names(shown)).toEqual(["Delta", "Alpha", "Beta", "Gamma"]);
  expect(shown.at(-1)?.row.state).toBe("working");
});

test("a paused bot rests with Paused as its line, never finished, and still reads needs you while it asks", () => {
  // Paused (ADR 0200 §6.1): at rest, not done and not working; its last word isn't its line.
  expect(
    row({ state: "paused", status: "Paused", working: false, last_message: said("Done.") }),
  ).toEqual({
    state: "rest",
    line: "Paused",
  });
  // A paused bot whose stopped work left a question open reads waiting, so it needs the person.
  expect(row({ state: "waiting", waiting_for: "question" }).state).toBe("needs-you");
  // A Spade from before paused sends only `working: false`: it reads at rest.
  expect(row({ state: "hibernating", working: false, last_message: said("Hi") })).toEqual({
    state: "rest",
    line: "Hi",
  });
});
