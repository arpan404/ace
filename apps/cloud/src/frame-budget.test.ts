import { expect, it } from "vitest";
import { FrameBudget } from "./frame-budget.ts";

it("a socket past its burst is refused until time refills its budget, without touching others", () => {
  const budget = new FrameBudget({ perSecond: 2, burst: 2 });
  expect(budget.take("a", 0)).toBe(true);
  expect(budget.take("a", 0)).toBe(true);
  expect(budget.take("a", 0)).toBe(false);
  expect(budget.take("b", 0)).toBe(true);
  expect(budget.take("a", 499)).toBe(false);
  expect(budget.take("a", 1000)).toBe(true);
});
