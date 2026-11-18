import { expect, test, vi } from "vitest";
import { WrapIndex } from "./wrap-index.ts";

/*
 * The row index over a whole document: row counts per line, both directions of the mapping, and
 * the promises that an edit re-measures only the lines it touched, a line-count change keeps
 * every surviving line in place, and a width change re-wraps the lines on screen first.
 */

function source(lines: string[]) {
  const line = vi.fn((index: number) => lines[index] ?? "");
  return { lenLines: () => lines.length, line };
}

function ready(lines: string[], columns = 20): WrapIndex {
  const index = new WrapIndex(source(lines));
  index.setColumns(columns, { first: 0, last: lines.length });
  index.pump(1_000_000);
  return index;
}

/** Every line's start row, for comparing one mapping with another. */
function starts(index: WrapIndex, lines: number): number[] {
  return Array.from({ length: lines }, (_, line) => index.startOf(line));
}

test("the index sums rows per line and maps lines and rows both ways", () => {
  const index = ready(["short", "x".repeat(200), "short"]);

  expect(index.total()).toBe(12);
  expect(index.startOf(0)).toBe(0);
  expect(index.startOf(1)).toBe(1);
  expect(index.startOf(2)).toBe(11);
  expect(index.lineAt(0)).toBe(0);
  expect(index.lineAt(1)).toBe(1);
  expect(index.lineAt(10)).toBe(1);
  expect(index.lineAt(11)).toBe(2);
  expect(index.lineAt(99)).toBe(2);
});

test("an edit re-measures only the lines it changed, never the file", () => {
  const lines = Array.from({ length: 100 }, () => "short");
  const text = source(lines);
  const index = new WrapIndex(text);
  index.setColumns(20, { first: 0, last: 100 });
  index.pump(1_000);
  text.line.mockClear();

  lines[3] = "y".repeat(100);
  index.apply([{ spans: [{ firstLine: 3, removedLines: 1, insertedLines: 1 }], lines: 100 }]);

  expect(text.line).toHaveBeenCalledTimes(1);
  expect(text.line).toHaveBeenCalledWith(3);
  expect(index.total()).toBe(104);
  expect(index.startOf(4)).toBe(8);
});

test("a whole-file replacement waits for the background pass instead of measuring in the edit", () => {
  const lines = Array.from({ length: 50_000 }, () => "short");
  const text = source(lines);
  const index = new WrapIndex(text);
  index.setColumns(20, { first: 0, last: 40 });
  index.pump(1_000_000);
  text.line.mockClear();

  index.apply([
    { spans: [{ firstLine: 0, removedLines: 50_000, insertedLines: 50_000 }], lines: 50_000 },
  ]);

  expect(text.line).not.toHaveBeenCalled();
  expect(index.pending()).toBe(50_000);
  index.pump(50_000);
  expect(text.line).toHaveBeenCalledTimes(50_000);
});

test("a width change re-wraps the lines on screen first and the rest as it has time", () => {
  const lines = Array.from({ length: 10_000 }, (_, at) => "x".repeat(at % 2 ? 30 : 10));
  const text = source(lines);
  const index = new WrapIndex(text);

  index.setColumns(20, { first: 5_000, last: 5_100 });

  expect(text.line).toHaveBeenCalledTimes(100);
  expect(index.total()).toBe(10_050);
  expect(index.pending()).toBe(9_900);

  index.pump(9_900);
  expect(index.pending()).toBe(0);
  expect(index.total()).toBe(15_000);
});

test("inserting a line moves the counts of the lines after it and measures the new one", () => {
  const lines = ["a", "b", "c"];
  const index = ready(lines, 10);
  expect(index.total()).toBe(3);

  lines.splice(1, 0, "a very long line here");
  index.apply([{ spans: [{ firstLine: 1, removedLines: 0, insertedLines: 1 }], lines: 4 }]);

  expect(index.total()).toBe(6);
  expect(index.startOf(0)).toBe(0);
  expect(index.startOf(1)).toBe(1);
  expect(index.startOf(2)).toBe(4);
  expect(index.startOf(3)).toBe(5);
  expect(index.lineAt(3)).toBe(1);
  expect(index.lineAt(4)).toBe(2);
});

test("Enter at the start of line 0 keeps every line below it in place", () => {
  const long = "x".repeat(100);
  const before = ["a", "b", long, "c"];
  const after = ["", "a", "b", long, "c"];
  const index = ready(before);
  before.splice(0, 1, "", "a");
  index.apply([{ spans: [{ firstLine: 0, removedLines: 1, insertedLines: 2 }], lines: 5 }]);

  const fresh = ready(after);
  expect(starts(index, after.length)).toEqual(starts(fresh, after.length));
  expect(index.total()).toBe(fresh.total());
  expect(index.startOf(3)).toBe(3);
});

test("two adjacent spans keep the lines between them in place", () => {
  const long = "x".repeat(100);
  const before = ["a", "b", "c", "d", long];
  const after = ["a", "b", "", "c", "", "d", long];
  const index = ready(before);
  before.splice(2, 1, "", "c");
  before.splice(4, 1, "", "d");
  index.apply([
    {
      spans: [
        { firstLine: 2, removedLines: 1, insertedLines: 2 },
        { firstLine: 4, removedLines: 1, insertedLines: 2 },
      ],
      lines: 7,
    },
  ]);

  const fresh = ready(after);
  expect(starts(index, after.length)).toEqual(starts(fresh, after.length));
  expect(index.total()).toBe(fresh.total());
});

test("an edit that adds a line somewhere and removes one elsewhere still keeps every line in place", () => {
  const long = "x".repeat(100);
  const before = ["a", long, "b", "c", "d"];
  const after = ["", "a", long, "b", "cd"];
  const index = ready(before);
  before.splice(0, 1, "", "a");
  before.splice(4, 2, "cd");
  index.apply([
    {
      spans: [
        { firstLine: 0, removedLines: 1, insertedLines: 2 },
        { firstLine: 4, removedLines: 2, insertedLines: 1 },
      ],
      lines: 5,
    },
  ]);

  const fresh = ready(after);
  expect(starts(index, after.length)).toEqual(starts(fresh, after.length));
  expect(index.total()).toBe(fresh.total());
});

test("a line-count change does not walk the whole file", () => {
  const lines = Array.from({ length: 10_000 }, () => "short");
  const text = source(lines);
  const index = new WrapIndex(text);
  index.setColumns(20, { first: 0, last: lines.length });
  index.pump(1_000_000);
  text.line.mockClear();
  lines.splice(5, 1, "short", "short");

  index.apply([{ spans: [{ firstLine: 5, removedLines: 1, insertedLines: 2 }], lines: 10_001 }]);

  expect(text.line).toHaveBeenCalledTimes(2);
  expect(index.total()).toBe(10_001);
});

test("with no width every line is one row and no text is read", () => {
  const text = source(["anything", "at all"]);
  const index = new WrapIndex(text);
  index.setColumns(Number.POSITIVE_INFINITY, { first: 0, last: 2 });

  expect(index.total()).toBe(2);
  expect(index.startOf(1)).toBe(1);
  expect(index.lineAt(1)).toBe(1);
  expect(text.line).not.toHaveBeenCalled();
});
