import { expect, test } from "vitest";
import { findMatches, joinWrapped, rowColumn, startingMatch, stepMatch } from "./search.ts";

const build = [
  "vitest run apps/server/src/replay.test.ts",
  " ✓ replays only events after lastAckedSeq (12 ms)",
  " ✗ treats seq 0 as a cold start",
  "Error: expected 200 events, got 1206",
  " ✓ drops duplicates already acked (3 ms)",
];

test("finds every occurrence, ignoring case unless asked", () => {
  expect(findMatches(build, "ACK").matches).toEqual([
    { line: 1, start: 33, end: 36 },
    { line: 4, start: 28, end: 31 },
  ]);
  expect(findMatches(build, "ACK", { caseSensitive: true, regex: false }).matches).toEqual([]);
});

test("a plain query treats regular-expression characters literally", () => {
  expect(findMatches(build, "(12 ms)").matches).toEqual([{ line: 1, start: 42, end: 49 }]);
});

test("a regular expression finds patterns, and an invalid one says why instead of throwing", () => {
  const timings = findMatches(build, String.raw`\(\d+ ms\)`, { caseSensitive: false, regex: true });
  expect(timings.matches.map((match) => match.line)).toEqual([1, 4]);
  const broken = findMatches(build, "(", { caseSensitive: false, regex: true });
  expect(broken.matches).toEqual([]);
  expect(broken.error).toBeTruthy();
});

test("an expression that matches nothing visible returns nothing rather than looping", () => {
  expect(findMatches(build, "z*", { caseSensitive: false, regex: true }).matches).toEqual([]);
});

test("stops at the limit and says more exist", () => {
  const log = Array.from({ length: 50 }, () => "retry retry retry");
  const result = findMatches(log, "retry", undefined, 100);
  expect(result.matches).toHaveLength(100);
  expect(result.truncated).toBe(true);
});

test("searching starts from the newest output in view and wraps both ways", () => {
  const matches = findMatches(build, "✓").matches;
  expect(startingMatch(matches)).toBe(1);
  expect(startingMatch(matches, 3)).toBe(0);
  expect(stepMatch(matches.length, 1, 1)).toBe(0);
  expect(stepMatch(matches.length, 0, -1)).toBe(1);
  expect(stepMatch(0, -1, 1)).toBe(-1);
});

test("a match on a line the terminal wrapped maps back to the row and column it shows on", () => {
  const rows = [
    { text: "$ bun run soak --clients 2", wrapped: false },
    { text: "client web-1 connected · resu", wrapped: false },
    { text: "me seq 1182", wrapped: true },
  ];
  const { lines, starts } = joinWrapped(rows);
  expect(lines).toEqual(["$ bun run soak --clients 2", "client web-1 connected · resume seq 1182"]);
  const [match] = findMatches(lines, "seq").matches;
  if (!match) throw new Error("expected a match");
  expect(rowColumn(starts, match, 29)).toEqual({ row: 2, column: 3 });
});
