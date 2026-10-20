import { expect, test } from "vitest";
import { nextSpeed, prefetchDistance, speedToward, type ScrollSpeed } from "./prefetch.ts";

/** Scrolls from `top` by `step` px (negative: up, toward older history) every 16ms. */
function scroll(top: number, step: number, frames: number, viewport = 900) {
  let speed: ScrollSpeed | undefined;
  let at = 0;
  for (let frame = 0; frame <= frames; frame++) {
    speed = nextSpeed(speed, top, at, viewport);
    top += step;
    at += 16;
  }
  return { speed, at: at - 16 };
}

test("a reader moving slowly has history read a few screens ahead of them", () => {
  expect(prefetchDistance(900, 0)).toBe(2_700);
  // A short viewport still keeps a page's worth of reading time ahead.
  expect(prefetchDistance(300, 0)).toBe(2_400);
});

test("a fast reader has history read as far ahead as they scroll before a page lands", () => {
  const { speed, at } = scroll(40_000, -160, 20);
  const toward = speedToward(true, speed, at);
  expect(toward).toBeCloseTo(10, 0);
  expect(prefetchDistance(900, toward)).toBeGreaterThan(9_000);
  // Moving the other way, newer history is what they approach.
  expect(speedToward(false, speed, at)).toBe(0);
});

test("a page landing above the reader is not counted as the reader moving", () => {
  const { speed, at } = scroll(40_000, -40, 10);
  const before = speedToward(true, speed, at);
  // The view is placed 17,000px down to keep the reader's row where it was.
  const placed = nextSpeed(speed, (speed?.top ?? 0) + 17_000, at + 16, 900);
  expect(speedToward(true, placed, at + 16)).toBeCloseTo(before, 5);
  expect(speedToward(false, placed, at + 16)).toBe(0);
});

test("a reader who paused reads history only a few screens ahead again", () => {
  const { speed, at } = scroll(40_000, -160, 20);
  expect(speedToward(true, speed, at + 500)).toBe(0);
  // Their next scroll after the pause starts from rest.
  const resumed = nextSpeed(speed, (speed?.top ?? 0) - 10, at + 500, 900);
  expect(resumed.speed).toBe(0);
});
