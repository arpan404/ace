import { expect, test } from "vitest";
import type { ActiveGroups } from "./home-groups.ts";
import {
  activeRows,
  homeFootStart,
  homeRowKey,
  settledRows,
  type ActiveRowGroups,
  type HomeRow,
} from "./home-rows.ts";

/** The rows as short words, to read the list top to bottom. */
const words = (rows: readonly HomeRow[]) =>
  rows.map((row) => {
    switch (row.kind) {
      case "pinned-header":
        return `pinned ${row.count}`;
      case "pinned-end":
        return "—";
      case "group-header":
        return `${row.group} ${row.count}${row.open ? "" : " (folded)"}`;
      case "snoozed-header":
        return `snoozed ${row.count}`;
      case "settled-header":
        return row.count === undefined ? row.label : `${row.label} ${row.count}`;
      case "settled-more":
        return `more ${row.state}`;
      case "unsent":
        return "unsent";
      default:
        return row.id;
    }
  });

const none: ActiveGroups = {
  "needs-you": [],
  running: [],
  today: [],
  yesterday: [],
  week: [],
  earlier: [],
  listed: [],
};
const arranged = (
  groups: Partial<ActiveGroups>,
  rest: Partial<Omit<ActiveRowGroups, "groups">> = {},
): ActiveRowGroups => ({ pinned: [], snoozed: [], ...rest, groups: { ...none, ...groups } });

test("Pinned leads, then each group with threads under its heading, in the panel's order", () => {
  const rows = activeRows(
    arranged(
      { today: ["t"], "needs-you": ["n"], running: ["r"], earlier: ["e"] },
      { pinned: ["p"] },
    ),
  );
  expect(words(rows)).toEqual([
    "pinned 1",
    "p",
    "—",
    "needs-you 1",
    "n",
    "running 1",
    "r",
    "today 1",
    "t",
    "earlier 1",
    "e",
  ]);
});

test("with nothing pinned there is no Pinned heading, except as a drop zone mid-drag", () => {
  expect(words(activeRows(arranged({ today: ["a"] })))).toEqual(["today 1", "a"]);
  expect(words(activeRows(arranged({ today: ["a"] }), { pinZone: true }))).toEqual([
    "pinned 0",
    "—",
    "today 1",
    "a",
  ]);
});

test("a folded group keeps its heading and count, and only the open thread in sight", () => {
  const groups = arranged({ today: ["a", "b", "c"], yesterday: ["y"] });
  expect(words(activeRows(groups, { collapsed: ["today"] }))).toEqual([
    "today 3 (folded)",
    "yesterday 1",
    "y",
  ]);
  expect(words(activeRows(groups, { collapsed: ["today"], current: "b" }))).toEqual([
    "today 3 (folded)",
    "b",
    "yesterday 1",
    "y",
  ]);
});

test("unsent work leads, above the Pinned group", () => {
  expect(
    words(activeRows(arranged({ today: ["a"] }, { pinned: ["p"] }), { includeUnsent: true })),
  ).toEqual(["unsent", "pinned 1", "p", "—", "today 1", "a"]);
});

test("Snoozed closes the Active tab and shows its threads only when open", () => {
  const groups = arranged({ today: ["a"] }, { snoozed: ["z1", "z2"] });
  expect(words(activeRows(groups))).toEqual(["today 1", "a", "snoozed 2"]);
  expect(words(activeRows(groups, { snoozedOpen: true }))).toEqual([
    "today 1",
    "a",
    "snoozed 2",
    "z1",
    "z2",
  ]);
  expect(words(activeRows(groups, { current: "z2" }))).toEqual(["today 1", "a", "snoozed 2", "z2"]);
});

test("while searching, matching settled threads follow the active matches under their heading", () => {
  const rows = activeRows(arranged({ running: ["r"] }), { settledMatches: ["s1", "s2"] });
  expect(words(rows)).toEqual(["running 1", "r", "Settled 2", "s1", "s2"]);
});

test("the foot starts at the Snoozed heading", () => {
  const rows = activeRows(arranged({ today: ["a"] }, { snoozed: ["z"] }));
  expect(homeFootStart(rows.map((item) => ({ item })))).toBe(2);
  expect(homeFootStart(activeRows(arranged({ today: ["a"] })).map((item) => ({ item })))).toBe(-1);
});

test("no thread id can take a heading's key, whatever it is called", () => {
  const rows = activeRows(
    arranged(
      { today: ["section:pinned-header", "group:today"] },
      { pinned: ["p"], snoozed: ["s"] },
    ),
    { settledMatches: ["section:settled:matches"] },
  );
  const keys = rows.map(homeRowKey);
  expect(new Set(keys).size).toBe(keys.length);
});

test("a thread keeps its key in every group and tab, so each move slides", () => {
  const keys = [
    homeRowKey({ kind: "pinned", id: "x" }),
    homeRowKey({ kind: "thread", id: "x", group: "running" }),
    homeRowKey({ kind: "thread", id: "x", group: "today" }),
    homeRowKey({ kind: "settled", id: "x" }),
  ];
  expect(new Set(keys).size).toBe(1);
});

const local = (month: number, date: number, hour = 12, year = 2026) =>
  new Date(year, month - 1, date, hour).getTime();

test("the Settled tab groups by week, then by month, newest first", () => {
  // Saturday 31 October 2026.
  const now = local(10, 31, 15);
  const rows = settledRows(
    [
      { id: "today", at: local(10, 31, 9) },
      { id: "monday", at: local(10, 26, 9) },
      { id: "last-sunday", at: local(10, 25, 9) },
      { id: "last-monday", at: local(10, 19, 9) },
      { id: "october", at: local(10, 18, 9) },
      { id: "september", at: local(9, 3) },
      { id: "last-year", at: local(12, 20, 12, 2025) },
    ],
    now,
  );
  expect(words(rows)).toEqual([
    "This week",
    "today",
    "monday",
    "Last week",
    "last-sunday",
    "last-monday",
    "October",
    "october",
    "September",
    "september",
    "December 2025",
    "last-year",
  ]);
});

test("the Settled tab says when older threads are loading or failed to load", () => {
  const now = local(10, 31);
  expect(words(settledRows([{ id: "a", at: now }], now, "loading"))).toEqual([
    "This week",
    "a",
    "more loading",
  ]);
  expect(words(settledRows([], now, "error"))).toEqual(["more error"]);
});

test("a hand-sorted list draws its threads under no heading, even when folded", () => {
  expect(words(activeRows(arranged({ listed: ["b", "a"] }), { collapsed: ["listed"] }))).toEqual([
    "b",
    "a",
  ]);
});
