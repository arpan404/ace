import { expect, test } from "vitest";
import { samePlain } from "./same-plain.ts";

test.each([
  ["equal strings", "a", "a", true],
  ["different numbers", 1, 2, false],
  [
    "objects in another key order",
    { a: 1, b: [1, { c: "x" }] },
    { b: [1, { c: "x" }], a: 1 },
    true,
  ],
  ["a field set to undefined and one left out", { a: 1, b: undefined }, { a: 1 }, true],
  ["a field present on one side only", { a: 1, b: 2 }, { a: 1 }, false],
  ["arrays of different length", [1, 2], [1], false],
  ["an array and an object", [1], { 0: 1 }, false],
  ["null and an empty object", null, {}, false],
  ["a nested change", { files: [{ still: "data:a" }] }, { files: [{ still: "data:b" }] }, false],
])("%s compare as JSON would", (_label, a, b, same) => {
  expect(samePlain(a, b)).toBe(same);
});
