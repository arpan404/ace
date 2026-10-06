import { expect, test } from "vitest";
import { homeRowKey, homeRows, type HomeGroups } from "./home-rows.ts";

/** The rows as short words, to read the list top to bottom. */
const words = (rows: ReturnType<typeof homeRows>) =>
  rows.map((row) =>
    row.kind === "settled-header"
      ? `settled ${row.count}`
      : row.kind === "pinned-header"
        ? `pinned ${row.count}`
        : row.kind === "pinned-end"
          ? "—"
          : row.id,
  );
const groups = (patch: Partial<HomeGroups>): HomeGroups => ({
  pinned: [],
  active: [],
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
  expect(words(homeRows(groups({ active: ["a"] }), { settledOpen: false }))).toEqual([
    "a",
    "settled 0",
  ]);
  expect(words(homeRows(groups({ active: ["a"] }), { settledOpen: false, pinZone: true }))).toEqual(
    ["pinned 0", "—", "a", "settled 0"],
  );
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
});
