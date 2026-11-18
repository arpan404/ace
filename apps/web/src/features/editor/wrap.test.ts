import { expect, test } from "vitest";
import { graphemes } from "./geometry.ts";
import { columnOnRow, leadingIndent, rowOfColumn, rowOffset, rowText, wrapLine } from "./wrap.ts";

/*
 * Word wrap as arithmetic on one line: where the rows break, the indent a continuation repeats,
 * and where a caret or a click lands. No document, no DOM.
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

test("continuation rows repeat the line's leading whitespace as indent", () => {
  const text = "    one two three";
  const rows = wrapLine(text, 12);
  expect(rows.map((row) => rowText(text, row))).toEqual(["    one two", "three"]);
  expect(rows.map((row) => row.indent)).toEqual([0, 4]);
  expect(leadingIndent("\t  text")).toBe(4);
});

test("a generated line over ten thousand characters wraps by code unit, never by width", () => {
  // Each 中 is one code unit but two cells: a row of 80 proves no cell measurement happened.
  const text = "中".repeat(12_000);
  const rows = wrapLine(text, 80);
  expect(rows[0]?.end).toBe(80);
  expect(rows.length).toBe(150);
  expect(rows.every((row) => row.end - row.start <= 80)).toBe(true);
});

test("a column in the space between rows belongs to the row before it", () => {
  const text = "aa bbbbb";
  const rows = wrapLine(text, 4);
  expect(rows.map((row) => rowText(text, row))).toEqual(["aa", "bbbbb"]);
  expect(rowOfColumn(rows, 0)).toBe(0);
  expect(rowOfColumn(rows, 2)).toBe(0);
  expect(rowOfColumn(rows, 3)).toBe(1);
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
