import { expect, test } from "vitest";
import { lineHeight } from "./geometry.ts";
import { editorWindow, windowOverscan } from "./row-window.ts";
import { WrapIndex } from "./wrap-index.ts";

/*
 * The row window around a scroll position: the lines it measures before reading a height, the
 * rows past each edge, and the whole document mounting when it is short enough.
 */

function index(lines: string[], columns = 20): WrapIndex {
  const created = new WrapIndex({
    lenLines: () => lines.length,
    line: (at) => lines[at] ?? "",
    version: () => 0,
  });
  created.setColumns(columns, { first: 0, last: 0 });
  return created;
}

test("the lines about to be shown are measured before the window reads the row total", () => {
  const lines = Array.from({ length: 1_000 }, () => "x".repeat(30));
  const layout = index(lines);

  const window = editorWindow({ layout, lineCount: lines.length, scrollTop: 0, height: 220 });

  // Nine two-row lines fill the eighteen rows on screen; they were measured, not estimated.
  expect(window.lastLine).toBe(9);
  expect(layout.startOf(9)).toBe(18);
  expect(window.rows).toBeGreaterThan(1_000);
  expect(window.all).toBe(false);
  // A line the window never measured keeps its one-row estimate.
  expect(layout.startOf(501) - layout.startOf(500)).toBe(1);
});

test("a short document mounts every row and every line", () => {
  const lines = Array.from({ length: 10 }, () => "short");
  const layout = index(lines);

  const window = editorWindow({ layout, lineCount: 10, scrollTop: 0, height: 660 });

  expect(window).toEqual({
    rows: 10,
    all: true,
    firstRow: 0,
    lastRow: 10,
    firstLine: 0,
    lastLine: 10,
  });
});

test("the window follows the scroll by visual row", () => {
  const lines = Array.from({ length: 1_000 }, () => "short");
  const layout = index(lines);
  layout.prefer({ first: 0, last: 1_000 });

  const window = editorWindow({
    layout,
    lineCount: lines.length,
    scrollTop: 44 * lineHeight,
    height: 220,
  });

  expect(window.firstRow).toBe(44 - windowOverscan);
  expect(window.lastRow).toBe(54 + windowOverscan);
  expect(window.firstLine).toBe(36);
  expect(window.lastLine).toBe(62);
});
