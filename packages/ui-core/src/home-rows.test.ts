import { expect, test } from "vitest";
import { homeOrder, homeRowKey, homeRows } from "./home-rows.ts";

/** The rows as short words, to read the list top to bottom. */
const words = (rows: ReturnType<typeof homeRows>) =>
  rows.map((row) => (row.kind === "settled-header" ? `settled ${row.count}` : row.id));

test("pinned threads lead, then the rest in Home order, whatever project they are in", () => {
  const order = homeOrder([
    { id: "asks", pinned: false },
    { id: "pin-later", pinned: true },
    { id: "work", pinned: false },
    { id: "pin-old", pinned: true },
  ]);
  expect(order).toEqual(["pin-later", "pin-old", "asks", "work"]);
});

test("Settled closes the list and lists its threads only when open", () => {
  expect(words(homeRows(["a", "b"], ["s1", "s2"], { settledOpen: false }))).toEqual([
    "a",
    "b",
    "settled 2",
  ]);
  expect(words(homeRows(["a"], ["s1", "s2"], { settledOpen: true }))).toEqual([
    "a",
    "settled 2",
    "s1",
    "s2",
  ]);
});

test("no thread id can take the Settled heading's key, whatever it is called", () => {
  const rows = homeRows(["section:settled-header", "thread:x", "a"], ["s"], { settledOpen: true });
  const keys = rows.map(homeRowKey);
  expect(new Set(keys).size).toBe(keys.length);
});

test("a thread keeps its key when it moves between active and settled, so the move slides", () => {
  const before = homeRows(["a"], [], { settledOpen: true }).map(homeRowKey);
  const after = homeRows([], ["a"], { settledOpen: true }).map(homeRowKey);
  expect(after).toContain(before[0]);
});
