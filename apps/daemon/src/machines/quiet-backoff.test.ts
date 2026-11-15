import { expect, test } from "vitest";
import { QuietBackoff } from "./quiet-backoff.ts";

test("polls that see nothing change wait longer each time, up to the cap", () => {
  const backoff = new QuietBackoff(1000, 5000);
  expect([false, false, false, false].map((changed) => backoff.next(changed))).toEqual([
    2000, 4000, 5000, 5000,
  ]);
});

test("a poll that sees a change, or something new to watch, goes back to the base pace", () => {
  const backoff = new QuietBackoff(1000, 5000);
  backoff.next(false);
  backoff.next(false);
  expect(backoff.next(true)).toBe(1000);
  backoff.next(false);
  backoff.reset();
  expect(backoff.waitMs).toBe(1000);
});
