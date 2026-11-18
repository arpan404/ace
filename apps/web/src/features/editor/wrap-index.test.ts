import { expect, test, vi } from "vitest";
import { WrapIndex } from "./wrap-index.ts";

/*
 * The row index over a whole document: row counts per line, both directions of the mapping, and
 * the promise that an edit re-measures only the lines it touched.
 */

function source(lines: string[]): { lenLines(): number; line: ReturnType<typeof vi.fn> } {
  const line = vi.fn((index: number) => lines[index] ?? "");
  return { lenLines: () => lines.length, line };
}

test("the index sums rows per line and maps lines and rows both ways", () => {
  const lines = ["short", "x".repeat(200), "short"];
  const index = new WrapIndex(source(lines));
  index.setColumns(20, { first: 0, last: 3 });

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
  index.apply([{ firstLine: 3, removedLines: 1, insertedLines: 1 }], 100);

  expect(text.line).toHaveBeenCalledTimes(1);
  expect(text.line).toHaveBeenCalledWith(3);
  expect(index.total()).toBe(104);
  expect(index.startOf(4)).toBe(8);
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
  const index = new WrapIndex(source(lines));
  index.setColumns(10, { first: 0, last: 3 });
  expect(index.total()).toBe(3);

  lines.splice(1, 0, "a very long line here");
  index.apply([{ firstLine: 1, removedLines: 0, insertedLines: 1 }], 4);

  expect(index.total()).toBe(6);
  expect(index.startOf(0)).toBe(0);
  expect(index.startOf(1)).toBe(1);
  expect(index.startOf(2)).toBe(4);
  expect(index.startOf(3)).toBe(5);
  expect(index.lineAt(3)).toBe(1);
  expect(index.lineAt(4)).toBe(2);
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
