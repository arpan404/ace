import { expect, test } from "vitest";
import { applySuggestions, suggestionOf } from "./suggestions.ts";

test("a comment's one suggestion block gives its replacement lines, ignoring other code blocks", () => {
  expect(
    suggestionOf(
      "Prefer a constant.\n\n```ts\nconst old = 1;\n```\n\n```suggestion\nconst a = 1;\nconst b = 2;\n```\n<!-- ace-write:x -->",
    ),
  ).toEqual(["const a = 1;", "const b = 2;"]);
  expect(suggestionOf("```suggestion\r\nfixed\r\n```")).toEqual(["fixed"]);
  expect(suggestionOf("Drop it:\n```suggestion\n```")).toEqual([]);
});

test("no suggestion, two suggestions or an unclosed one is nothing to apply", () => {
  expect(suggestionOf("Looks good")).toBeUndefined();
  expect(suggestionOf("```suggestion\na\n```\n```suggestion\nb\n```")).toBeUndefined();
  expect(suggestionOf("```suggestion\na")).toBeUndefined();
  // A suggestion fence quoted inside a longer fence is an example, not a suggestion.
  expect(suggestionOf("````md\n```suggestion\na\n```\n````")).toBeUndefined();
});

test("suggestions replace their line ranges and keep the file's line endings and final newline", () => {
  expect(
    applySuggestions("one\ntwo\nthree\nfour\n", [
      { startLine: 4, endLine: 4, lines: [] },
      { startLine: 1, endLine: 2, lines: ["first"] },
    ]),
  ).toBe("first\nthree\n");
  expect(applySuggestions("a\r\nb", [{ startLine: 2, endLine: 2, lines: ["c", "d"] }])).toBe(
    "a\r\nc\r\nd",
  );
});

test("suggestions that overlap or reach past the end of the file are refused", () => {
  expect(
    applySuggestions("a\nb\nc\n", [
      { startLine: 1, endLine: 2, lines: ["x"] },
      { startLine: 2, endLine: 3, lines: ["y"] },
    ]),
  ).toBeUndefined();
  expect(applySuggestions("a\n", [{ startLine: 2, endLine: 2, lines: ["x"] }])).toBeUndefined();
});
