import { expect, test } from "vitest";
import { indexingLabel, resultCountLabel, snippetRuns } from "./search-snippet.ts";

test("a snippet splits into plain and matched runs at its highlight offsets", () => {
  expect(
    snippetRuns({ text: "run git diff --check now", highlights: [{ start: 4, end: 12 }] }),
  ).toEqual([
    { text: "run ", match: false },
    { text: "git diff", match: true },
    { text: " --check now", match: false },
  ]);
});

test("overlapping, unordered and out-of-range highlights merge without losing text", () => {
  const text = "replay window caps";
  const runs = snippetRuns({
    text,
    highlights: [
      { start: 7, end: 13 },
      { start: 0, end: 6 },
      { start: 3, end: 9 },
      { start: 40, end: 50 },
      { start: 5, end: 5 },
    ],
  });
  expect(runs.map((run) => run.text).join("")).toBe(text);
  expect(runs).toEqual([
    { text: "replay window", match: true },
    { text: " caps", match: false },
  ]);
});

test("markup in a snippet stays text", () => {
  const runs = snippetRuns({ text: "<b>x</b>", highlights: [{ start: 3, end: 4 }] });
  expect(runs.map((run) => run.text)).toEqual(["<b>", "x", "</b>"]);
});

test("result counts say when more pages remain", () => {
  expect(resultCountLabel(0, false, true)).toBe("Searching…");
  expect(resultCountLabel(0, false, false)).toBe("No results");
  expect(resultCountLabel(0, true, false)).toBe("None yet");
  expect(resultCountLabel(1, false, false)).toBe("1 result");
  expect(resultCountLabel(30, true, false)).toBe("30+ results");
  expect(resultCountLabel(1_204, false, false)).toBe("1,204 results");
});

test("pending indexing is named only while events wait", () => {
  expect(indexingLabel(0)).toBeUndefined();
  expect(indexingLabel(1_240)).toContain("1,240 recent events");
});
