import { expect, it } from "vitest";
import { FramePace } from "@ace/relay";
import { LimitsSchema } from "@ace/relay/wire";
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

it("a sender that waits as its frame pace says is never refused by the relay object's budget", () => {
  const limits = LimitsSchema.parse({});
  const budget = new FrameBudget({
    perSecond: limits.messagesPerSecond,
    burst: limits.messageBurst,
  });
  const pace = new FramePace();
  let now = 0;
  // Bursts of 3,000 frames written as fast as allowed, with a pause between some of them.
  for (const pause of [0, 0, 500, 0, 2_000, 0]) {
    now += pause;
    for (let frame = 0; frame < 3_000; frame++) {
      now += pace.take(now);
      expect(budget.take("daemon", now)).toBe(true);
    }
  }
  // And it isn't held far below the budget: 18,000 frames in about 18,000 / 900 per second.
  expect(now).toBeLessThan(20_000);
});
