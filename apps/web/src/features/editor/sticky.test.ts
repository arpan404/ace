import { expect, test } from "vitest";
import { stickyHeaders } from "./sticky.ts";

const source = [
  "class A {", // 0
  "  method() {", // 1
  "    if (x) {", // 2
  "      y();", // 3
  "", // 4
  "      z();", // 5
  "    }", // 6
  "  }", // 7
  "}", // 8
  "after();", // 9
];
const at = (lines: readonly string[]) => (line: number) => lines[line] ?? "";
const headers = (top: number, max = 5, lookback = 1000) =>
  stickyHeaders({
    lineAt: at(source),
    lineCount: source.length,
    top,
    indentSize: 2,
    max,
    lookback,
  });

test("the blocks around the top line pin their headers, outermost first", () => {
  expect(headers(3)).toEqual([0, 1, 2]);
  expect(headers(7)).toEqual([0]);
});

test("a header on screen at the top pins nothing above what encloses it", () => {
  expect(headers(0)).toEqual([]);
  expect(headers(2)).toEqual([0, 1]);
});

test("a closing line at its header's depth is outside the block", () => {
  expect(headers(6)).toEqual([0, 1]);
  expect(headers(8)).toEqual([]);
  expect(headers(9)).toEqual([]);
});

test("a blank top line takes the depth of the next line with text", () => {
  expect(headers(4)).toEqual([0, 1, 2]);
});

test("only the innermost headers are kept when there are more than fit", () => {
  expect(headers(3, 2)).toEqual([1, 2]);
});

test("the search upwards stops at its lookback, so a long block costs a bounded read", () => {
  const long = ["outer {", ...Array.from({ length: 50 }, () => "  line();")];
  const read: number[] = [];
  const lineAt = (line: number) => {
    read.push(line);
    return long[line] ?? "";
  };
  expect(
    stickyHeaders({ lineAt, lineCount: long.length, top: 40, indentSize: 2, max: 5, lookback: 10 }),
  ).toEqual([]);
  expect(Math.min(...read)).toBeGreaterThanOrEqual(30);
  expect(
    stickyHeaders({ lineAt, lineCount: long.length, top: 40, indentSize: 2, max: 5, lookback: 50 }),
  ).toEqual([0]);
});
