import { expect, test } from "vitest";
import { overviewTicks, type OverviewInput } from "./overview.ts";

/** A 1,000-line file without wrapping, on a 500px ruler. */
const base: OverviewInput = {
  rows: 1_000,
  viewRows: 40,
  height: 500,
  rowOf: (line) => line,
  rowsOf: () => 1,
  marks: undefined,
  agent: undefined,
  hits: [],
  caretLine: undefined,
};

const hit = (line: number) => ({ start: { line, column: 0 }, end: { line, column: 3 } });

test("each change sits at its place in the whole file", () => {
  const ticks = overviewTicks({
    ...base,
    marks: new Map([
      [1, "added"],
      [501, "modified"],
    ]),
  });
  expect(ticks.map((tick) => [tick.kind, tick.line, tick.top])).toEqual([
    ["added", 0, 0],
    ["modified", 500, 250],
  ]);
});

test("an agent's block is one tick as tall as its lines, and wins over the commit's mark", () => {
  const ticks = overviewTicks({
    ...base,
    marks: new Map([[101, "modified"]]),
    agent: [{ start: 100, end: 120, label: "Claude Code changed this in turn 2" }],
  });
  expect(ticks.map((tick) => [tick.kind, tick.top, tick.height])).toEqual([["agent", 50, 10]]);
});

test("many hits on nearby lines draw one tick per pixel", () => {
  const hits = Array.from({ length: 10_000 }, (_, index) => hit(index % 1_000));
  const ticks = overviewTicks({ ...base, hits });
  expect(ticks.length).toBe(500);
  expect(ticks.every((tick) => tick.lane === "hit")).toBe(true);
});

test("the caret has its own lane, over the changes", () => {
  const ticks = overviewTicks({ ...base, marks: new Map([[11, "added"]]), caretLine: 10 });
  expect(ticks.map((tick) => [tick.lane, tick.top])).toEqual([
    ["change", 5],
    ["caret", 5],
  ]);
});

test("a file shorter than the view maps its lines where they are drawn", () => {
  const ticks = overviewTicks({
    ...base,
    rows: 10,
    viewRows: 50,
    marks: new Map([[10, "added"]]),
  });
  // Line 10 of a 50-row view at 500px: 90px down, not at the bottom.
  expect(ticks[0]?.top).toBe(90);
});
