import { expect, test } from "vitest";
import type { FileDiff } from "@ace/ui-core";
import { placeComments } from "./pr-code-comments.ts";

const diff: FileDiff = {
  path: "src/a.ts",
  status: "modified",
  additions: 2,
  deletions: 2,
  rows: [
    { kind: "context", old: 1, new: 1, text: "a" },
    { kind: "del", old: 2, text: "b" },
    { kind: "del", old: 3, text: "c" },
    { kind: "add", new: 2, text: "B" },
    { kind: "add", new: 3, text: "C" },
    { kind: "context", old: 4, new: 4, text: "d" },
    { kind: "fold", count: 10 },
    { kind: "context", old: 15, new: 15, text: "o" },
  ],
};
const thread = (over: object) => ({
  id: "T",
  resolved: false,
  outdated: false,
  file: "src/a.ts",
  line: 3,
  comments: [],
  ...over,
});

test("a conversation from a deleted line to an added line sits under its last line and marks every row between", () => {
  const placed = placeComments(
    diff,
    [thread({ startLine: 3, startSide: "LEFT", side: "RIGHT", line: 2 })],
    [],
  );
  expect([...placed.threads.keys()]).toEqual(["new:2"]);
  expect([...placed.covered]).toEqual(["old:3", "new:2"]);
});

test("a comment on the old side of an unchanged line sits under that line's row", () => {
  const placed = placeComments(diff, [thread({ side: "LEFT", line: 4 })], []);
  expect([...placed.threads.keys()]).toEqual(["new:4"]);
});

const draft = (path: string, line: number) => ({
  id: `${path}:${line}`,
  body: "x",
  anchor: { commit: "a".repeat(40), path, line, side: "RIGHT" as const, startLine: 2 },
});

test("pending drafts are placed like conversations; lines in a fold or another file aren't placed", () => {
  const placed = placeComments(
    diff,
    [thread({ line: 9, side: "RIGHT" })],
    [draft("src/a.ts", 3), draft("src/a.ts", 9), draft("src/b.ts", 3)],
  );
  expect([...placed.threads.keys()]).toEqual([]);
  expect([...placed.drafts.keys()]).toEqual(["new:3"]);
  expect([...placed.covered]).toEqual(["new:2", "new:3"]);
});
