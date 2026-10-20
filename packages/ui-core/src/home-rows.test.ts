import { expect, test } from "vitest";
import {
  homeFootStart,
  homeRowKey,
  homeRows,
  settledFirstRows,
  settledMoreRows,
  type HomeGroups,
} from "./home-rows.ts";

/** The rows as short words, to read the list top to bottom. */
const words = (rows: ReturnType<typeof homeRows>) =>
  rows.map((row) => {
    if (row.kind === "settled-header" || row.kind === "snoozed-header")
      return `${row.kind === "settled-header" ? "settled" : "snoozed"} ${row.count}`;
    if (row.kind === "settled-more") return `more ${row.count}`;
    if (row.kind === "pinned-header") return `pinned ${row.count}`;
    if (row.kind === "pinned-end") return "—";
    return "id" in row ? row.id : "unsent";
  });
const groups = (patch: Partial<HomeGroups>): HomeGroups => ({
  pinned: [],
  active: [],
  recent: [],
  snoozed: [],
  settled: [],
  ...patch,
});

test("the Pinned group leads under its heading, then the rest, then Settled", () => {
  const rows = homeRows(groups({ pinned: ["p1", "p2"], active: ["a"], settled: ["s"] }), {
    settledOpen: false,
  });
  expect(words(rows)).toEqual(["pinned 2", "p1", "p2", "—", "a", "settled 1"]);
});

test("with nothing pinned there is no Pinned heading, except as a drop zone mid-drag", () => {
  expect(words(homeRows(groups({ active: ["a"] }), { settledOpen: false }))).toEqual(["a"]);
  expect(words(homeRows(groups({ active: ["a"] }), { settledOpen: false, pinZone: true }))).toEqual(
    ["pinned 0", "—", "a"],
  );
});

test("threads at rest follow the work in hand without an extra heading", () => {
  expect(
    words(homeRows(groups({ active: ["a"], recent: ["r1", "r2"] }), { settledOpen: false })),
  ).toEqual(["a", "r1", "r2"]);
  expect(words(homeRows(groups({ pinned: ["p"], recent: ["r"] }), { settledOpen: false }))).toEqual(
    ["pinned 1", "p", "—", "r"],
  );
  // With only threads at rest, a heading over the whole list would say nothing.
  expect(words(homeRows(groups({ recent: ["r"] }), { settledOpen: false }))).toEqual(["r"]);
});

test("Settled closes the list and lists its threads only when open", () => {
  expect(
    words(homeRows(groups({ active: ["a"], settled: ["s1", "s2"] }), { settledOpen: true })),
  ).toEqual(["a", "settled 2", "s1", "s2"]);
});

test("no thread id can take a heading's key, whatever it is called", () => {
  const rows = homeRows(
    groups({ pinned: ["section:pinned-header"], active: ["section:settled-header", "thread:x"] }),
    { settledOpen: true },
  );
  const keys = rows.map(homeRowKey);
  expect(new Set(keys).size).toBe(keys.length);
});

/** The keys of the thread rows alone. */
const threadKeys = (patch: Partial<HomeGroups>) =>
  homeRows(groups(patch), { settledOpen: true })
    .filter((row) => "id" in row)
    .map(homeRowKey);

test("a thread keeps its key when pinned, unpinned or settled, so each move slides", () => {
  expect(threadKeys({ pinned: ["a"] })).toEqual(threadKeys({ active: ["a"] }));
  expect(threadKeys({ settled: ["a"] })).toEqual(threadKeys({ active: ["a"] }));
  expect(threadKeys({ recent: ["a"] })).toEqual(threadKeys({ active: ["a"] }));
});

test("an empty Settled group stays out of the list even when expanded", () => {
  expect(words(homeRows(groups({ active: ["a"] }), { settledOpen: true }))).toEqual(["a"]);
});

test("unsent work leads the list, above the Pinned group", () => {
  expect(
    words(
      homeRows(
        groups({ pinned: ["pin"], active: ["active"], recent: ["recent"], settled: ["settled"] }),
        { settledOpen: true, includeUnsent: true },
      ),
    ),
  ).toEqual(["unsent", "pinned 1", "pin", "—", "active", "recent", "settled 1", "settled"]);
});

test("Snoozed follows the tasks and precedes Settled, exposing its tasks only when open", () => {
  const list = groups({ active: ["asks"], snoozed: ["later"], settled: ["done"] });
  expect(words(homeRows(list, { settledOpen: false, includeUnsent: true }))).toEqual([
    "unsent",
    "asks",
    "snoozed 1",
    "settled 1",
  ]);
  expect(words(homeRows(list, { snoozedOpen: true, settledOpen: true }))).toEqual([
    "asks",
    "snoozed 1",
    "later",
    "settled 1",
    "done",
  ]);
});

const ids = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);

test("an open Settled section shows its first rows, then offers the next batch", () => {
  const settled = ids("s", 40);
  const rows = homeRows(groups({ active: ["a"], settled }), {
    settledOpen: true,
    settledShown: settledFirstRows,
    settledTotal: 85,
  });
  // The heading counts every settled thread, loaded or not; the button names what it reveals.
  expect(words(rows)).toEqual([
    "a",
    "settled 85",
    ...settled.slice(0, 10),
    `more ${settledMoreRows}`,
  ]);
});

test("the last batch names only what is left, and nothing is offered once all show", () => {
  const settled = ids("s", 12);
  expect(words(homeRows(groups({ settled }), { settledOpen: true, settledShown: 10 })).at(-1)).toBe(
    "more 2",
  );
  expect(words(homeRows(groups({ settled }), { settledOpen: true, settledShown: 35 })).at(-1)).toBe(
    "s12",
  );
});

test("the batch counts threads the daemon has not sent yet", () => {
  const rows = homeRows(groups({ settled: ids("s", 20) }), {
    settledOpen: true,
    settledShown: 20,
    settledTotal: 30,
  });
  expect(words(rows).at(-1)).toBe("more 10");
});

test("a closed section keeps the open thread in sight under its heading", () => {
  const list = groups({ active: ["a"], snoozed: ["z1", "z2"], settled: ["s1", "s2"] });
  expect(words(homeRows(list, { settledOpen: false, current: "s2" }))).toEqual([
    "a",
    "snoozed 2",
    "settled 2",
    "s2",
  ]);
  expect(words(homeRows(list, { settledOpen: false, current: "z1" }))).toEqual([
    "a",
    "snoozed 2",
    "z1",
    "settled 2",
  ]);
});

test("the open settled thread shows even past the rows the section shows", () => {
  const settled = ids("s", 30);
  const rows = words(
    homeRows(groups({ settled }), { settledOpen: true, settledShown: 10, current: "s25" }),
  );
  expect(rows).toEqual(["settled 30", ...settled.slice(0, 10), "s25", "more 19"]);
});

const drawn = (rows: ReturnType<typeof homeRows>) => rows.map((item) => ({ item }));

test("the foot starts at the first section heading below the tasks", () => {
  const list = groups({ pinned: ["p"], active: ["a"], snoozed: ["z"], settled: ["s"] });
  const rows = homeRows(list, { settledOpen: false });
  expect(words(rows)[homeFootStart(drawn(rows))]).toBe("snoozed 1");
  const noSnooze = homeRows(groups({ active: ["a"], settled: ["s"] }), { settledOpen: false });
  expect(words(noSnooze)[homeFootStart(drawn(noSnooze))]).toBe("settled 1");
  expect(homeFootStart(drawn(homeRows(groups({ active: ["a"] }), { settledOpen: false })))).toBe(
    -1,
  );
});
