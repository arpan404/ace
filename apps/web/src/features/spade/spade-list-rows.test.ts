import { parseSpadeAgentValue, parseSpadeGroupValue } from "@ace/ui-core/spade-chat";
import { expect, test } from "vitest";
import {
  plainPreview,
  searchSpadeList,
  spadeBotRow,
  spadeListEntries,
  spadeNeedsYouCount,
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

const said = (text: string, from = "agent") => ({ from, text, at: 1, from_agent: null });

test("the list leaves Spade to the head and orders needs you, working, failed, unseen, then the rest by latest", () => {
  const bots = [
    bot({ id: "main", kind: "main", name: "Spade", last_activity: 99 }),
    bot({ id: "old", name: "Old", last_activity: 1, last_message: said("bye") }),
    bot({ id: "new", name: "New", last_activity: 50, last_message: said("hi") }),
    bot({ id: "seen-not", name: "Research", last_activity: 2, unseen: true }),
    bot({ id: "trips", name: "Trips", last_activity: 3, problem: "Codex is signed out." }),
    bot({ id: "inbox", name: "Inbox", last_activity: 4, state: "working", status: "Reading" }),
    bot({ id: "gh", name: "Github", last_activity: 0, state: "waiting", waiting_for: "question" }),
  ];
  const groups = [group({ id: "study", name: "Study", last_activity: 10 })];
  expect(
    spadeListEntries(bots, groups).map((entry) =>
      entry.kind === "bot" ? entry.bot.name : entry.group.name,
    ),
  ).toEqual(["Github", "Inbox", "Trips", "Research", "New", "Study", "Old"]);
});

test("each row's state and line follow the row-state table", () => {
  const row = (fields: Record<string, unknown>, place?: Partial<RosterBot>) =>
    spadeBotRow(bot({ id: "b", name: "B", ...fields }, place));
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
  // A Spade before the seen cursor says nothing: what it said counts as seen.
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

test("a preview reads as plain text, whatever markdown the message carried", () => {
  expect(
    plainPreview(
      "## Plan\n\n- **Weather:** clear, _9–20°C_\n- [the outage](https://x.y) ~~is~~ `ok`",
    ),
  ).toBe("Plan Weather: clear, 9–20°C the outage is ok");
  expect(plainPreview("> quoted\n```ts\nconst a = 1;\n```\n![a chart](c.png) 1. done")).toBe(
    "quoted const a = 1; a chart 1. done",
  );
  // Words that only look like marks stay.
  expect(plainPreview("snake_case and 2 * 3 * 4")).toBe("snake_case and 2 * 3 * 4");
});

test("search finds conversations by name, members and their words", () => {
  const entries = spadeListEntries(
    [
      bot({ id: "garden", name: "Garden", last_message: said("Water the **tomatoes**", "person") }),
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
