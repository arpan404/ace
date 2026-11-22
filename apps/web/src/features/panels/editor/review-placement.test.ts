import { turnHunks, diffFile, type TurnHunk } from "@ace/ui-core";
import { expect, test } from "vitest";
import { cachedExact, placeHunk } from "./review-placement.ts";

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
