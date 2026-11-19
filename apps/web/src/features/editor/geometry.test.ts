import { expect, test } from "vitest";
import { columnAtVisual, graphemes, lineWidth, visualColumn } from "./geometry.ts";

test("an emoji joined from several code points takes two cells, not one per code point", () => {
  const family = "👨‍👩‍👧‍👦";
  expect([...family].length).toBeGreaterThan(4);
  expect(visualColumn(family, family.length)).toBe(2);
  expect(columnAtVisual(family, 2)).toBe(family.length);
  expect(graphemes(family)).toHaveLength(1);
});

test("a combining mark stays part of its letter's single cell", () => {
  const accented = "e\u0301";
  expect(visualColumn(accented, accented.length)).toBe(1);
  expect(columnAtVisual(accented, 1)).toBe(accented.length);
});

test("tabs advance to the next stop and plain ASCII stays one cell each", () => {
  expect(visualColumn("\tx", 2)).toBe(3);
  expect(columnAtVisual("\tx", 2)).toBe(1);
  expect(lineWidth("abcd", 8)).toBe(32);
  expect(lineWidth("a\tb", 8)).toBe(24);
});
