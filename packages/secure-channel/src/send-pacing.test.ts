import { expect, it } from "vitest";
import { FLOW_WINDOW } from "./flow-credit.ts";
import { InFlightCap, MIN_IN_FLIGHT } from "./send-pacing.ts";

const FRAGMENT = 65519;

/**
 * A sender with endless data over a link of `bytesPerMs` and `roundTripMs`, credited one
 * fragment at a time as the far end reads it. Returns the limit after `durationMs`.
 */
function simulate(bytesPerMs: number, roundTripMs: number, durationMs: number) {
  const cap = new InFlightCap();
  const credits: { at: number; amount: number }[] = [];
  let linkFreeAt = 0;
  let peak = 0;
  for (let now = 0; now < durationMs; now++) {
    while (credits[0] && credits[0].at <= now) {
      const credit = credits.shift();
      if (credit) cap.credited(credit.amount, now);
    }
    while (cap.allows(FRAGMENT)) {
      cap.spent(FRAGMENT, now);
      linkFreeAt = Math.max(linkFreeAt, now + roundTripMs / 2) + FRAGMENT / bytesPerMs;
      credits.push({ at: linkFreeAt + roundTripMs / 2, amount: FRAGMENT });
    }
    cap.waiting();
    if (now > durationMs / 2) peak = Math.max(peak, cap.inFlight);
  }
  return { limit: cap.limit, peak };
}

it("on a 3G link the sender keeps a couple of fragments in flight, not the whole window", () => {
  const { peak } = simulate(50, 400, 60_000);
  expect(peak).toBeLessThanOrEqual(3 * FRAGMENT);
});

it("on a fast link the limit grows to fill the path", () => {
  // 50 Mbit/s and 60 ms: a bandwidth-delay product of 375 KB.
  const { peak } = simulate(6250, 60, 5_000);
  expect(peak).toBeGreaterThanOrEqual(375_000);
  expect(peak).toBeLessThanOrEqual(FLOW_WINDOW);
});

it("the limit never drops under two fragments, so credit always comes back", () => {
  const { limit } = simulate(5, 2000, 120_000);
  expect(limit).toBeGreaterThanOrEqual(MIN_IN_FLIGHT);
});

it("a sender with nothing in flight may always send", () => {
  const cap = new InFlightCap();
  expect(cap.allows(FLOW_WINDOW)).toBe(true);
});
