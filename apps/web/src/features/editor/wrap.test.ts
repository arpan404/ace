import { expect, test, vi } from "vitest";
import { graphemes, longLine, visualColumn } from "./geometry.ts";
import {
  atHardBreak,
  columnOnRow,
  leadingIndent,
  rowOfColumn,
  rowOffset,
  rowText,
  wrapLine,
  type WrapRows,
} from "./wrap.ts";

/*
 * Word wrap as arithmetic on one line: where the rows break, the indent a continuation repeats,
 * where the caret lands, and the whitespace a row keeps or drops. No document, no DOM.
 */

/** Every row of a line, with a whole-line row's open end read as the line's own end. */
const rowsOf = (text: string, columns: number) =>
  Array.from(wrapLine(text, columns), (row) => ({ ...row, end: Math.min(row.end, text.length) }));

const slices = (text: string, columns: number) =>
  Array.from(wrapLine(text, columns), (row) => rowText(text, row));

test("a long line wraps at the spaces that fit, each break's run staying at its row's end", () => {
  expect(slices("one two three four", 8)).toEqual(["one two ", "three ", "four"]);
});

test("a word wider than the row breaks between graphemes, never inside one", () => {
  const family = "👨‍👩‍👧‍👦";
  const text = family.repeat(14);
  const rows = rowsOf(text, 12);
  expect(rows.length).toBeGreaterThan(1);
  const parts = rows.map((row) => rowText(text, row));
  expect(parts.join("")).toBe(text);
  for (const part of parts) {
    expect(graphemes(part).map((one) => one.text)).toEqual(
      Array(part.length / family.length).fill(family),
    );
  }
});

test("a run of spaces stays with the row it broke, so every column in it has its own x", () => {
  expect(slices("aa  bbbbbbbb", 8)).toEqual(["aa  ", "bbbbbbbb"]);
});

test("continuation rows repeat the line's leading whitespace as indent", () => {
  const text = "    one two three";
  const rows = rowsOf(text, 12);
  expect(rows.map((row) => rowText(text, row))).toEqual(["    one two ", "three"]);
  expect(rows.map((row) => row.indent)).toEqual([0, 4]);
  expect(leadingIndent("\t  text")).toBe(4);
});

test("the line's own indentation is never a place to break, however deep it is", () => {
  const text = `${" ".repeat(10)}abcdef`;
  const rows = rowsOf(text, 12);
  expect(rows.map((row) => rowText(text, row))).toEqual([`${" ".repeat(10)}ab`, "cdef"]);
  expect(rows.map((row) => row.indent)).toEqual([0, 4]);
});

test("whitespace after the last word stays on the last row, past the row's edge", () => {
  expect(rowsOf("aaa bbb   ", 8)).toEqual([{ start: 0, end: 10, indent: 0 }]);
  expect(rowsOf(`a${" ".repeat(20)}`, 8)).toEqual([{ start: 0, end: 21, indent: 0 }]);
});

test("a long non-ASCII line wraps by cells and never splits a joined emoji", () => {
  const family = "👨‍👩‍👧‍👦";
  const text = family.repeat(2_000);
  expect(text.length).toBeGreaterThan(longLine);
  const rows = rowsOf(text, 20);
  const parts = rows.map((row) => rowText(text, row));

  expect(parts.join("")).toBe(text);
  expect(rows.length).toBe(200);
  for (const part of parts) {
    // Every row holds whole families: no row boundary falls inside a ZWJ sequence.
    expect(part.length % family.length).toBe(0);
    expect(visualColumn(part, part.length)).toBeLessThanOrEqual(20);
  }
});

test("a long line of combining marks keeps each base with its marks", () => {
  const text = "e\u0301".repeat(6_000);
  expect(text.length).toBeGreaterThan(longLine);
  // An odd row of cells would end between a base and its mark if units were the break unit.
  const rows = rowsOf(text, 9);

  for (const row of rows) {
    const part = rowText(text, row);
    expect(part.length % 2).toBe(0);
    expect(visualColumn(part, part.length)).toBeLessThanOrEqual(9);
  }
  expect(rows.map((row) => rowText(text, row)).join("")).toBe(text);
});

test("a long line with tabs wraps at its real tab stops instead of overflowing", () => {
  const text = `\t${"a".repeat(400)}`.repeat(50);
  expect(text.length).toBeGreaterThan(longLine);
  const rows = rowsOf(text, 10);

  for (const row of rows) {
    expect(row.indent + visualColumn(rowText(text, row), row.end - row.start)).toBeLessThanOrEqual(
      10,
    );
  }
});

test("a megabyte line with one tab is read as code units, never as graphemes", () => {
  const text = `${"x".repeat(500_000)}\t${"x".repeat(500_000)}`;
  const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
  try {
    const rows = wrapLine(text, 80);
    // The whole line is ASCII, so a tab cannot join a cluster and nothing needs segmenting.
    expect(segment).not.toHaveBeenCalled();
    expect(rows.length).toBeGreaterThan(10_000);
    expect(rows.at(rows.length - 1)?.end).toBe(text.length);
  } finally {
    segment.mockRestore();
  }
});

test("a generated line of plain ASCII over ten thousand characters still wraps by code unit", () => {
  // Printable ASCII is exactly one cell per unit, so the fast path needs no cluster work.
  const text = "x".repeat(12_000);
  const rows = rowsOf(text, 80);
  expect(rows[0]?.end).toBe(80);
  expect(rows.length).toBe(150);
});

test("a width narrower than a row's least text is raised to it", () => {
  expect(slices("aaaa bbbb", 4)).toEqual(["aaaa ", "bbbb"]);
  expect(rowsOf("aaaa bbbb", 4)).toEqual(rowsOf("aaaa bbbb", 8));
});

test("a column in the space between rows belongs to the row before it", () => {
  const text = "aaa bbbbb";
  const rows = rowsOf(text, 8);
  expect(rows.map((row) => rowText(text, row))).toEqual(["aaa ", "bbbbb"]);
  expect(rowOfColumn(rows, 0)).toBe(0);
  expect(rowOfColumn(rows, 3)).toBe(0);
  expect(rowOfColumn(rows, 4)).toBe(1);
  expect(atHardBreak(rows, 0, 3)).toBe(false);
});

test("a column at a hard break stays on the row before it when the caret asks to", () => {
  const text = "中".repeat(10);
  const rows = rowsOf(text, 8);
  expect(rows.map((row) => rowText(text, row))).toEqual(["中中中中", "中中中中", "中中"]);

  expect(rowOfColumn(rows, 4)).toBe(1);
  expect(rowOfColumn(rows, 4, true)).toBe(0);
  expect(atHardBreak(rows, 0, 4)).toBe(true);
  expect(atHardBreak(rows, 1, 8)).toBe(true);
  expect(rowOfColumn(rows, 2, true)).toBe(0);
});

test("a row's cells measure from its own left edge, indent included", () => {
  const text = "    one two three";
  const rows = rowsOf(text, 12);
  const cell = 8;
  const second = rows.at(1);
  if (!second) throw new Error("the line should wrap");
  expect(rowOffset(text, second, second.start)).toBe(4);
  expect(rowOffset(text, second, second.start + 3)).toBe(7);
  expect(columnOnRow(text, second, (4 + 3) * cell + 1, cell)).toBe(second.start + 3);
});

test("every column of a wrapped line keeps its own x, the spaces at a break included", () => {
  const text = "one two   three four five";
  const rows = rowsOf(text, 10);
  const cell = 8;
  const taken = new Map<string, number>();
  for (let column = 0; column <= text.length; column++) {
    const at = rowOfColumn(rows, column);
    const row = rows.at(at);
    if (!row) throw new Error(`Column ${column} fell outside the line`);
    const x = rowOffset(text, row, column);
    const key = `${at}:${x}`;
    const other = taken.get(key);
    if (other !== undefined) throw new Error(`Columns ${other} and ${column} both draw at ${x}`);
    taken.set(key, column);
    // Hit testing comes back to the same column through the same range.
    if (column < text.length) expect(columnOnRow(text, row, x * cell + 1, cell)).toBe(column);
  }
});

test("the row of a column on a very long line is found without walking the rows", () => {
  let reads = 0;
  // Every row materialized by the search is one read: a walk would touch every row before it.
  const counted: WrapRows = {
    length: 100_000,
    at(index) {
      reads++;
      return index < 0 || index >= 100_000
        ? undefined
        : { start: index * 8, end: (index + 1) * 8, indent: 0 };
    },
    *[Symbol.iterator]() {
      for (let index = 0; index < 100_000; index++)
        yield { start: index, end: index + 1, indent: 0 };
    },
  };

  expect(rowOfColumn(counted, 8 * 79_999)).toBe(79_999);
  expect(rowOfColumn(counted, 8 * 79_999, true)).toBe(79_998);
  expect(reads).toBeLessThan(64);
});

test("a line narrower than the row stays on one row, whatever it holds", () => {
  expect(slices("short", 20)).toEqual(["short"]);
  expect(slices("héllo 👋", 20)).toEqual(["héllo 👋"]);
  expect(slices("", 20)).toEqual([""]);
  expect(wrapLine("short", Number.POSITIVE_INFINITY).length).toBe(1);
});
