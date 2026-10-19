import { expect, test } from "vitest";
import { magnifyScales } from "./rail-magnify.ts";

/** `count` ticks `spacing` pixels apart, from the top of the rail. */
const rail = (count: number, spacing: number) =>
  Array.from({ length: count }, (_, index) => index * spacing);

test("the tick under the pointer grows most and growth falls off evenly on both sides", () => {
  const scales = magnifyScales(80, rail(21, 8), 8);
  const peak = scales[10] ?? 0;
  expect(Math.max(...scales)).toBe(peak);
  expect(peak).toBeGreaterThan(1);
  for (let step = 1; step < 4; step += 1) {
    const above = scales[10 - step] ?? 0;
    expect(above).toBeCloseTo(scales[10 + step] ?? 0);
    expect(above).toBeLessThan(scales[10 - step + 1] ?? 0);
    expect(above).toBeGreaterThan(1);
  }
});

test("ticks more than a few neighbours from the pointer stay at rest", () => {
  const scales = magnifyScales(80, rail(21, 8), 8);
  expect(scales.slice(0, 6)).toEqual([1, 1, 1, 1, 1, 1]);
  expect(scales.slice(14)).toEqual([1, 1, 1, 1, 1, 1, 1]);
});

test("with no pointer every tick rests", () => {
  expect(magnifyScales(undefined, rail(5, 8), 8)).toEqual([1, 1, 1, 1, 1]);
});

test("a pointer between two ticks grows both alike, each less than one right under it", () => {
  const between = magnifyScales(36, rail(10, 8), 8);
  const under = magnifyScales(32, rail(10, 8), 8);
  expect(between[4]).toBeCloseTo(between[5] ?? 0);
  expect(between[4]).toBeLessThan(under[4] ?? 0);
});

test("a crowded rail still swells visibly, across more than a few slivers", () => {
  const grown = magnifyScales(60, rail(41, 3), 3).filter((scale) => scale > 1).length;
  // More than four neighbours on each side of the one under the pointer.
  expect(grown).toBeGreaterThan(9);
});
