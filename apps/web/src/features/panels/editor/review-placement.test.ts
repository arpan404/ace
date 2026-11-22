import { turnHunks, diffFile, type TurnHunk } from "@ace/ui-core";
import { expect, test } from "vitest";
import { cachedExact, placeHunk, turnTexts } from "./review-placement.ts";

const rowsOf = (oldText: string, newText: string) =>
  diffFile({ path: "a.ts", changes: [{ kind: "update", path: "a.ts", oldText, newText }] }).rows;
const [hunk] = turnHunks(rowsOf("one\ntwo\nthree\n", "one\nTWO\nthree\n")) as [TurnHunk];
const now = ["one", "TWO", "three", ""];
const lineAt = (line: number) => now[line] ?? "";

test("a hunk found by its words alone (a turn known only by its patch) can't be reverted, even unmoved", () => {
  const placed = placeHunk(hunk, { kind: "patch", lineAt, lineCount: now.length });
  expect(placed).toMatchObject({ at: { start: 2 }, revertable: false });
});

test("a hunk carried by the exact changes since the turn can be reverted", () => {
  const placed = placeHunk(hunk, { kind: "text", changes: [] });
  expect(placed).toMatchObject({ at: { start: 2 }, revertable: true });
});

test("while the exact changes are still being worked out, the hunk isn't placed", () => {
  expect(placeHunk(hunk, { kind: "text", changes: undefined })).toBeUndefined();
});

test("a turn's exact hunks are reused only for the same text before and after it", () => {
  const cache = { before: "a\n", after: "b\n", hunks: [hunk] };
  expect(cachedExact(cache, { before: "a\n", after: "b\n" })).toEqual([hunk]);
  // Another turn ending in the same text, from another start: not the first turn's hunks.
  expect(cachedExact(cache, { before: "z\n", after: "b\n" })).toBeUndefined();
});

const change = (
  kind: "add" | "update" | "move",
  oldText: string | null | undefined,
  newText: string,
) => ({
  path: "a.ts",
  kind,
  ...(oldText === undefined ? {} : { oldText }),
  newText,
});

test.each([
  {
    name: "an update that recorded the text before it can be reverted from it",
    changes: [change("update", "a\n", "b\n")],
    texts: { before: "a\n", after: "b\n" },
  },
  {
    name: "an update that recorded only its result can't: the text before it is unknown",
    changes: [change("update", undefined, "b\n")],
    texts: undefined,
  },
  {
    name: "an update whose text before is null can't either",
    changes: [change("update", null, "b\n")],
    texts: undefined,
  },
  {
    name: "a file the turn created started empty",
    changes: [change("add", undefined, "b\n")],
    texts: { before: "", after: "b\n" },
  },
  {
    name: "a second change that doesn't start from the first's result breaks the chain",
    changes: [change("update", "a\n", "b\n"), change("update", "x\n", "c\n")],
    texts: undefined,
  },
  {
    name: "a chain of recorded changes runs from the first's text to the last's",
    changes: [change("add", undefined, "b\n"), change("update", "b\n", "c\n")],
    texts: { before: "", after: "c\n" },
  },
])("$name", ({ changes, texts }) => {
  expect(turnTexts(changes)).toEqual(texts);
});
