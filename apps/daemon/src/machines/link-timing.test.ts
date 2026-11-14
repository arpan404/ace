import { expect, test } from "vitest";
import { LinkTiming } from "./link-timing.ts";

test("a machine on a fast link keeps the base timeout", () => {
  const timing = new LinkTiming();
  for (let i = 0; i < 10; i++) timing.answered("studio", 20, i);
  expect(timing.timeout("studio", 4000, 20_000)).toBe(4000);
});

test("a machine on a slow link gets a longer timeout, within the cap", () => {
  const timing = new LinkTiming();
  for (let i = 0; i < 10; i++) timing.answered("phone-tethered", 1800, i);
  const timeout = timing.timeout("phone-tethered", 4000, 20_000);
  expect(timeout).toBeGreaterThan(4 * 1800);
  expect(timeout).toBeLessThanOrEqual(20_000);
  for (let i = 0; i < 10; i++) timing.answered("satellite", 9000, i);
  expect(timing.timeout("satellite", 4000, 20_000)).toBe(20_000);
});

test("a call that timed out makes the next timeout longer", () => {
  const timing = new LinkTiming();
  timing.answered("studio", 900, 1);
  const before = timing.timeout("studio", 4000, 20_000);
  timing.timedOut("studio", 4000);
  expect(timing.timeout("studio", 4000, 20_000)).toBeGreaterThan(before);
  expect(timing.answeredAt("studio")).toBe(1);
});

test("a machine never timed keeps the base timeout and has no last answer", () => {
  const timing = new LinkTiming();
  expect(timing.timeout("studio", 10_000, 40_000)).toBe(10_000);
  expect(timing.answeredAt("studio")).toBeUndefined();
});
