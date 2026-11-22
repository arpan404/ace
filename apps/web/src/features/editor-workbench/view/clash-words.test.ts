import { expect, test } from "vitest";
import { clashWords, conflictWords, linesWords } from "./clash-words.ts";

test.each([
  { lines: [{ from: 5, to: 5 }], words: "line 5" },
  { lines: [{ from: 2, to: 3 }], words: "lines 2–3" },
  {
    lines: [
      { from: 2, to: 3 },
      { from: 9, to: 9 },
    ],
    words: "lines 2–3 and 9",
  },
  {
    lines: [
      { from: 2, to: 3 },
      { from: 9, to: 9 },
      { from: 20, to: 22 },
    ],
    words: "lines 2–3, 9 and 1 more place",
  },
])("$words", ({ lines, words }) => {
  expect(linesWords(lines)).toBe(words);
});

test("the agent changed lines the person wasn't editing: no overlap", () => {
  expect(
    clashWords({
      who: "Claude Code",
      // Base lines 1–2 (0-based) rewritten; the person edited base line 4.
      theirs: [{ start: 1, end: 3, text: "b\nc\n" }],
      mine: [{ start: 4, end: 5, text: "mine\n" }],
    }),
  ).toBe("Claude Code changed lines 2–3 while you were editing line 5. No overlap.");
});

test("both sides changed the same line: it overlaps", () => {
  expect(
    clashWords({
      who: "Claude Code",
      theirs: [{ start: 4, end: 5, text: "theirs\n" }],
      mine: [{ start: 4, end: 5, text: "mine\n" }],
    }),
  ).toBe("Claude Code changed line 5 while you were editing line 5. One place overlaps.");
});

test("lines the agent added are named in the file as it has them now", () => {
  expect(
    clashWords({
      who: "Claude Code",
      // Two lines inserted at the top push the person's base line 4 down.
      theirs: [{ start: 0, end: 0, text: "x\ny\n" }],
      mine: [{ start: 3, end: 4, text: "mine\n" }],
    }),
  ).toBe("Claude Code changed lines 1–2 while you were editing line 4. No overlap.");
});

test("a change nobody can be named for says the file changed on disk", () => {
  expect(
    clashWords({
      who: undefined,
      theirs: [{ start: 0, end: 1, text: "x\n" }],
      mine: [{ start: 5, end: 6, text: "y\n" }],
    }),
  ).toBe("This file changed on disk at line 1 while you were editing line 6. No overlap.");
});

test("the conflict bar counts what is left to answer", () => {
  expect(conflictWords("Claude Code", 2, 0)).toBe(
    "Claude Code and you both changed 2 places. Choose a side for each to finish the merge.",
  );
  expect(conflictWords("Claude Code", 2, 1)).toBe(
    "Claude Code and you both changed 2 places. Choose a side for the 1 left to finish the merge.",
  );
  expect(conflictWords(undefined, 1, 0)).toBe(
    "The disk and you both changed 1 place. Choose a side for it to finish the merge.",
  );
});
