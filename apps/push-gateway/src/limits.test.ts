import { expect, it } from "vitest";
import { HourlyLimit } from "./limits.ts";

it("does not refill the same time interval twice when requests arrive out of order", () => {
  const limit = new HourlyLimit(1, 2);
  const hour = 3_600_000;
  expect(limit.take("handle", 0)).toBe(0);
  expect(limit.take("handle", hour / 2)).toBe(hour / 2);
  expect(limit.take("handle", 0)).toBe(hour);
  expect(limit.take("handle", hour / 2)).toBe(hour / 2);
  expect(limit.take("handle", hour)).toBe(0);
});
