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
  type WrapRow,
} from "./wrap.ts";

/*
 * Word wrap as arithmetic on one line: where the rows break, the indent a continuation repeats,
 * where the caret lands, and the whitespace a row keeps or drops. No document, no DOM.
 */

const slices = (text: string, columns: number) =>
  wrapLine(text, columns).map((row) => rowText(text, row));

test("a long line wraps at the spaces that fit, each break's run staying at its row's end", () => {
  expect(slices("one two three four", 8)).toEqual(["one two ", "three ", "four"]);
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

test("a run of spaces stays with the row it broke, so every column in it has its own x", () => {
  expect(slices("aa  bbbbbbbb", 8)).toEqual(["aa  ", "bbbbbbbb"]);
});

test("continuation rows repeat the line's leading whitespace as indent", () => {
  const text = "    one two three";
  const rows = wrapLine(text, 12);
  expect(rows.map((row) => rowText(text, row))).toEqual(["    one two ", "three"]);
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
  expect(slices("aaaa bbbb", 4)).toEqual(["aaaa ", "bbbb"]);
  expect(wrapLine("aaaa bbbb", 4)).toEqual(wrapLine("aaaa bbbb", 8));
});

test("a column in the space between rows belongs to the row before it", () => {
  const text = "aaa bbbbb";
  const rows = wrapLine(text, 8);
  expect(rows.map((row) => rowText(text, row))).toEqual(["aaa ", "bbbbb"]);
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

test("every column of a wrapped line keeps its own x, the spaces at a break included", () => {
  const text = "one two   three four five";
  const rows = wrapLine(text, 10);
  const cell = 8;
  const taken = new Map<string, number>();
  for (let column = 0; column <= text.length; column++) {
    const at = rowOfColumn(rows, column);
    const row = rows[at];
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
  const rows: WrapRow[] = [];
  for (let at = 0; at < 100_000; at++) rows.push({ start: at * 8, end: (at + 1) * 8, indent: 0 });
  let reads = 0;
  const counted = new Proxy(rows, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });

  expect(rowOfColumn(counted, 8 * 79_999)).toBe(79_999);
  expect(rowOfColumn(counted, 8 * 79_999, true)).toBe(79_998);
  expect(reads).toBeLessThan(64);
});

test("a line narrower than the row stays on one row, whatever it holds", () => {
  expect(slices("short", 20)).toEqual(["short"]);
  expect(slices("héllo 👋", 20)).toEqual(["héllo 👋"]);
  expect(slices("", 20)).toEqual([""]);
  expect(wrapLine("short", Number.POSITIVE_INFINITY)).toHaveLength(1);
});
