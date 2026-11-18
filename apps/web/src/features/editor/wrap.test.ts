import { expect, test } from "vitest";
import { graphemes } from "./geometry.ts";
import {
  atHardBreak,
  columnOnRow,
  leadingIndent,
  rowOfColumn,
  rowOffset,
  rowText,
  wrapLine,
} from "./wrap.ts";

/*
 * Word wrap as arithmetic on one line: where the rows break, the indent a continuation repeats,
 * where the caret lands, and the whitespace a row keeps or drops. No document, no DOM.
 */

const slices = (text: string, columns: number) =>
  wrapLine(text, columns).map((row) => rowText(text, row));

test("a long line wraps at the spaces that fit, dropping the space at each break", () => {
  expect(slices("one two three four", 8)).toEqual(["one two", "three", "four"]);
});

test("a word wider than the row breaks between graphemes, never inside one", () => {
  const family = "👨‍👩‍👧‍👦";
  const text = family.repeat(14);
  const rows = wrapLine(text, 12);
  expect(rows.length).toBeGreaterThan(1);
  const parts = rows.map((row) => rowText(text, row));
  expect(parts.join("")).toBe(text);
  for (const part of parts) {
    expect(graphemes(part).map((one) => one.text)).toEqual(
      Array(part.length / family.length).fill(family),
    );
  }
});

test("a run of spaces is dropped whole, leaving no stray space at the row's end", () => {
  expect(slices("aa  bbbbbbbb", 8)).toEqual(["aa", "bbbbbbbb"]);
});

test("continuation rows repeat the line's leading whitespace as indent", () => {
  const text = "    one two three";
  const rows = wrapLine(text, 12);
  expect(rows.map((row) => rowText(text, row))).toEqual(["    one two", "three"]);
  expect(rows.map((row) => row.indent)).toEqual([0, 4]);
  expect(leadingIndent("\t  text")).toBe(4);
});

test("the line's own indentation is never a place to break, however deep it is", () => {
  const text = `${" ".repeat(10)}abcdef`;
  const rows = wrapLine(text, 12);
  expect(rows.map((row) => rowText(text, row))).toEqual([`${" ".repeat(10)}ab`, "cdef"]);
  expect(rows.map((row) => row.indent)).toEqual([0, 4]);
});

test("whitespace after the last word stays on the last row, past the row's edge", () => {
  expect(wrapLine("aaa bbb   ", 8)).toEqual([{ start: 0, end: 10, indent: 0 }]);
  expect(wrapLine(`a${" ".repeat(20)}`, 8)).toEqual([{ start: 0, end: 21, indent: 0 }]);
});

test("a generated line over ten thousand characters wraps by code unit, never by width", () => {
  // Each 中 is one code unit but two cells: a row of 80 proves no cell measurement happened.
  const text = "中".repeat(12_000);
  const rows = wrapLine(text, 80);
  expect(rows[0]?.end).toBe(80);
  expect(rows.length).toBe(150);
  expect(rows.every((row) => row.end - row.start <= 80)).toBe(true);
});

test("a width narrower than a row's least text is raised to it", () => {
  expect(slices("aaaa bbbb", 4)).toEqual(["aaaa", "bbbb"]);
  expect(wrapLine("aaaa bbbb", 4)).toEqual(wrapLine("aaaa bbbb", 8));
});

test("a column in the space between rows belongs to the row before it", () => {
  const text = "aaa bbbbb";
  const rows = wrapLine(text, 8);
  expect(rows.map((row) => rowText(text, row))).toEqual(["aaa", "bbbbb"]);
  expect(rowOfColumn(rows, 0)).toBe(0);
  expect(rowOfColumn(rows, 3)).toBe(0);
  expect(rowOfColumn(rows, 4)).toBe(1);
  expect(atHardBreak(rows, 0, 3)).toBe(false);
});

test("a column at a hard break stays on the row before it when the caret asks to", () => {
  const text = "中".repeat(10);
  const rows = wrapLine(text, 8);
  expect(rows.map((row) => rowText(text, row))).toEqual(["中中中中", "中中中中", "中中"]);

  expect(rowOfColumn(rows, 4)).toBe(1);
  expect(rowOfColumn(rows, 4, true)).toBe(0);
  expect(atHardBreak(rows, 0, 4)).toBe(true);
  expect(atHardBreak(rows, 1, 8)).toBe(true);
  expect(rowOfColumn(rows, 2, true)).toBe(0);
});

test("a row's cells measure from its own left edge, indent included", () => {
  const text = "    one two three";
  const rows = wrapLine(text, 12);
  const cell = 8;
  const second = rows[1];
  if (!second) throw new Error("the line should wrap");
  expect(rowOffset(text, second, second.start)).toBe(4);
  expect(rowOffset(text, second, second.start + 3)).toBe(7);
  expect(columnOnRow(text, second, (4 + 3) * cell + 1, cell)).toBe(second.start + 3);
});

test("a line narrower than the row stays on one row, whatever it holds", () => {
  expect(slices("short", 20)).toEqual(["short"]);
  expect(slices("héllo 👋", 20)).toEqual(["héllo 👋"]);
  expect(slices("", 20)).toEqual([""]);
  expect(wrapLine("short", Number.POSITIVE_INFINITY)).toHaveLength(1);
});
