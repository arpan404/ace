import { expect, test } from "vitest";
import { retryDelay } from "./index.ts";

test("retry ceilings double until capped and full jitter can select the whole interval", () => {
  expect(retryDelay(0, 200, 500, 0.75)).toBe(150);
  expect(retryDelay(1, 200, 500, 0.75)).toBe(300);
  expect(retryDelay(2, 200, 500, 0.75)).toBe(375);
  expect(retryDelay(30, 200, 500, 0.75)).toBe(375);
  expect(retryDelay(30, 200, 500, 0)).toBe(0);
  expect(retryDelay(30, 200, 500, 0.999)).toBe(499.5);
  expect(() => retryDelay(1, 200, 500, Number.NaN)).toThrow("Random sample");
});
