import { expect, test } from "vitest";
import {
  groupHome,
  homeRowKey,
  homeRows,
  type GroupEntry,
  type HomeRowOptions,
} from "./home-groups.ts";

const thread = (id: string, project: string, patch: Partial<GroupEntry> = {}): GroupEntry => ({
  id,
  project,
  pinned: false,
  needsYou: false,
  ...patch,
});
const options = (patch: Partial<HomeRowOptions> = {}): HomeRowOptions => ({
  closed: new Set(),
  showingAll: new Set(),
  settledOpen: false,
  ...patch,
});
/** The rows as short words, to read the list top to bottom. */
const words = (rows: ReturnType<typeof homeRows>) =>
  rows.map((row) => {
    switch (row.kind) {
      case "pinned-label":
        return "[pinned]";
      case "folder":
        return `${row.open ? "v" : ">"} ${row.project}`;
      case "more":
        return row.showingAll ? `less ${row.project}` : `more ${row.project} +${row.hidden}`;
      case "settled-header":
        return `settled ${row.count}`;
      case "rule":
        return "rule";
      default:
        return row.id;
    }
  });

test("pinned threads lead on their own; the rest fall into folders ordered by what is owed", () => {
  const groups = groupHome([
    thread("asks", "billing", { needsYou: true }),
    thread("pin", "relay", { pinned: true }),
    thread("work", "relay"),
    thread("more-billing", "billing"),
  ]);
  expect(words(homeRows(groups, ["old"], options()))).toEqual([
    "[pinned]",
    "pin",
    "v billing",
    "asks",
    "more-billing",
    "v relay",
    "work",
    "settled 1",
  ]);
});

test("a folder shows five threads, then Show more; showing all offers Show less", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  const groups = groupHome(ids.map((id) => thread(id, "ace")));
  expect(words(homeRows(groups, [], options()))).toEqual([
    "v ace",
    "a",
    "b",
    "c",
    "d",
    "e",
    "more ace +2",
    "settled 0",
  ]);
  expect(words(homeRows(groups, [], options({ showingAll: new Set(["ace"]) })))).toContain(
    "less ace",
  );
  expect(
    words(homeRows(groups, [], options({ showingAll: new Set(["ace"]) }))).filter(
      (word) => word.length === 1,
    ),
  ).toEqual(ids);
});

test("the open thread shows in its folder even past the first five", () => {
  const groups = groupHome(["a", "b", "c", "d", "e", "f", "g"].map((id) => thread(id, "ace")));
  const rows = words(homeRows(groups, [], options({ open: "g" })));
  expect(rows).toContain("g");
  expect(rows).not.toContain("f");
  expect(rows).toContain("more ace +1");
});

test("a closed folder hides its threads but says when one needs you", () => {
  const groups = groupHome([thread("asks", "billing", { needsYou: true }), thread("x", "relay")]);
  const rows = homeRows(groups, [], options({ closed: new Set(["billing"]) }));
  expect(words(rows)).toEqual(["> billing", "v relay", "x", "settled 0"]);
  expect(rows[0]).toMatchObject({ kind: "folder", needsYou: true, count: 1 });
});

test("Settled lists its threads and the auto-settle rule only when open", () => {
  const groups = groupHome([]);
  expect(words(homeRows(groups, ["s1", "s2"], options({ settledOpen: true })))).toEqual([
    "settled 2",
    "s1",
    "s2",
    "rule",
  ]);
});

test("no thread id can take a folder's, Show more's or a heading's key, whatever it is called", () => {
  const groups = groupHome([
    thread("folder:ace", "ace"),
    thread("more:ace", "ace"),
    thread("section:settled-header", "ace"),
    thread("thread:x", "ace", { pinned: true }),
    ...["a", "b", "c", "d"].map((id) => thread(id, "ace")),
  ]);
  const keys = homeRows(groups, ["s"], options({ settledOpen: true })).map(homeRowKey);
  expect(new Set(keys).size).toBe(keys.length);
});
