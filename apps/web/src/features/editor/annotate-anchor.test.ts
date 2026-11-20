import type { TextReplacement } from "@ace/editor";
import { expect, test } from "vitest";
import { findOnce, mapSpan, reanchor, verify } from "./annotate-anchor.ts";

/* Keeping a range on its code: through edits, through whole-text rewrites, at open. */

const at = (line: number, column: number) => ({ line, column });
const span = (a: [number, number], b: [number, number]) => ({ start: at(...a), end: at(...b) });
/** A replaced range: old start and end, and where the new text ends afterwards. */
const replaced = (
  start: [number, number],
  end: [number, number],
  postEnd: [number, number],
): TextReplacement => ({ start: at(...start), end: at(...end), postEnd: at(...postEnd) });

test("edits above a range move it; edits below leave it", () => {
  const range = span([4, 2], [6, 8]);
  // Two lines typed on line 1.
  expect(mapSpan(range, [replaced([1, 0], [1, 0], [3, 0])])).toEqual({
    ...span([6, 2], [8, 8]),
    outdated: false,
  });
  // Typing on the range's first line, before it, moves its start along the line only.
  expect(mapSpan(range, [replaced([4, 0], [4, 0], [4, 3])])).toEqual({
    ...span([4, 5], [6, 8]),
    outdated: false,
  });
  expect(mapSpan(range, [replaced([9, 0], [9, 4], [9, 0])])).toEqual({ ...range, outdated: false });
});

test("text typed on the range's own edges joins it", () => {
  const range = span([2, 4], [2, 9]);
  expect(mapSpan(range, [replaced([2, 4], [2, 4], [2, 6])])).toEqual({
    ...span([2, 4], [2, 11]),
    outdated: false,
  });
  expect(mapSpan(range, [replaced([2, 9], [2, 9], [2, 12])])).toEqual({
    ...span([2, 4], [2, 12]),
    outdated: false,
  });
});

test("a deletion over one edge shrinks the range to what is left of its code", () => {
  const range = span([2, 4], [2, 9]);
  // "ab|cdefg|hi" with "cd" deleted from before the start into the range.
  expect(mapSpan(range, [replaced([2, 2], [2, 6], [2, 2])])).toEqual({
    ...span([2, 2], [2, 5]),
    outdated: false,
  });
  expect(mapSpan(range, [replaced([2, 7], [2, 12], [2, 7])])).toEqual({
    ...span([2, 4], [2, 7]),
    outdated: false,
  });
});

test("code deleted from outside its edges leaves an outdated point; text put exactly in its place stays annotated", () => {
  const range = span([3, 0], [5, 0]);
  expect(mapSpan(range, [replaced([2, 0], [6, 0], [2, 0])])).toEqual({
    ...span([2, 0], [2, 0]),
    outdated: true,
  });
  expect(mapSpan(range, [replaced([3, 0], [5, 0], [3, 7])]).outdated).toBe(false);
  expect(mapSpan(range, [replaced([2, 5], [5, 3], [2, 9])])).toEqual({
    ...span([2, 9], [2, 9]),
    outdated: true,
  });
});

test("several replaced ranges in one edit (multi-cursor) each shift what follows", () => {
  const range = span([1, 10], [1, 14]);
  // "x" typed at columns 2 and 6 of the same line, and a line break inserted on line 0.
  const edit = [
    replaced([0, 3], [0, 3], [1, 0]),
    replaced([1, 2], [1, 2], [2, 3]),
    replaced([1, 6], [1, 6], [2, 8]),
  ];
  expect(mapSpan(range, edit)).toEqual({ ...span([2, 12], [2, 16]), outdated: false });
});

const lines = (text: string) => text.split("\n");

test("a rewrite below or above a range keeps it on the same code", () => {
  const before = ["a", "b", "keep me", "c", "d"];
  const kept = span([2, 0], [2, 7]);
  const below = [...before.slice(0, 4), "new", "d"];
  expect(reanchor(kept, { text: "keep me" }, before, below, below.join("\n"))).toEqual({
    ...kept,
    outdated: false,
  });
  const above = ["new", "lines", ...before];
  expect(reanchor(kept, { text: "keep me" }, before, above, above.join("\n"))).toEqual({
    ...span([4, 0], [4, 7]),
    outdated: false,
  });
});

test("a rewrite around a range finds its code by its exact text, once, or calls it outdated", () => {
  const before = lines("top\nfunction a() {\n  return 1;\n}\nbottom");
  const range = span([1, 0], [3, 1]);
  const code = { text: "function a() {\n  return 1;\n}" };
  const moved = lines("TOP\nimport x;\n\nfunction a() {\n  return 1;\n}\nBOTTOM");
  expect(reanchor(range, code, before, moved, moved.join("\n"))).toEqual({
    ...span([3, 0], [5, 1]),
    outdated: false,
  });
  // Changed code is not followed to look-alikes: the range is outdated where it was.
  const changed = lines("TOP\nfunction a() {\n  return 2;\n}\nBOTTOM");
  expect(reanchor(range, code, before, changed, changed.join("\n"))).toEqual({
    ...span([1, 0], [1, 0]),
    outdated: true,
  });
  // Two copies: nothing says which, so neither.
  const twice = lines(`X\n${code.text}\n${code.text}\nY`);
  expect(reanchor(range, code, before, twice, twice.join("\n")).outdated).toBe(true);
  expect(findOnce(twice.join("\n"), code.text)).toBeUndefined();
});

test("a rewrite never moves a range onto another copy of its code", () => {
  // The annotated "foo" is the second of two; the rewrite changes it and keeps the first.
  const before = lines("a\nfoo\nb\nfoo\nc");
  const second = span([3, 0], [3, 3]);
  const after = lines("a\nfoo\nB\nbar\nc");
  expect(reanchor(second, { text: "foo" }, before, after, after.join("\n"))).toEqual({
    ...span([3, 0], [3, 0]),
    outdated: true,
  });
  // Once in each text, but what stands around it on its lines differs: other code.
  const assigned = lines("top\nlet x = y;\nend");
  const value = span([1, 8], [1, 9]);
  const reused = lines("TOP\n\nlet x = q;\nw = y + 1\nend");
  expect(reanchor(value, { text: "y" }, assigned, reused, reused.join("\n")).outdated).toBe(true);
  // The same line moved under new code keeps its annotation.
  const moved = lines("TOP\n\nlet x = y;\nend");
  expect(reanchor(value, { text: "y" }, assigned, moved, moved.join("\n"))).toEqual({
    ...span([2, 8], [2, 9]),
    outdated: false,
  });
});

test("at open, a stored range is checked against the file's text", () => {
  const text = "one\ntwo\nthree";
  expect(verify(span([1, 0], [1, 3]), { text: "two" }, lines(text), text)).toEqual({
    ...span([1, 0], [1, 3]),
    outdated: false,
  });
  const moved = "zero\none\ntwo\nthree";
  expect(verify(span([1, 0], [1, 3]), { text: "two" }, lines(moved), moved)).toEqual({
    ...span([2, 0], [2, 3]),
    outdated: false,
  });
  const gone = "one\nthree";
  expect(verify(span([1, 0], [1, 3]), { text: "two" }, lines(gone), gone)).toEqual({
    ...span([1, 0], [1, 0]),
    outdated: true,
  });
});
