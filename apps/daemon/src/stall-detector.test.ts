import { expect, test } from "vitest";
import { createStallDetector } from "./stall-detector.ts";

const options = { thresholdMs: 1_000, repeatMs: 5_000, maxCaptures: 3, cooldownMs: 60_000 };

/** Checks every 100 ms from `from` to `to`, with the heartbeat frozen at `beat`. */
function silence(
  detector: ReturnType<typeof createStallDetector>,
  from: number,
  to: number,
  beat: number,
) {
  const seen = [];
  for (let now = from; now <= to; now += 100) seen.push(detector.observe(now, beat));
  return seen;
}

test("a heartbeat that keeps changing is never a stall", () => {
  const detector = createStallDetector(options);
  for (let now = 0, beat = 0; now < 10_000; now += 100, beat++)
    expect(detector.observe(now, beat)).toEqual({ type: "healthy" });
});

test("a main thread silent past the threshold is looked at once, then reported when it returns", () => {
  const detector = createStallDetector(options);
  detector.observe(0, 1);
  const seen = silence(detector, 100, 3_000, 1);
  const captures = seen.filter((o) => o.type === "stalled" && o.capture);
  expect(captures).toEqual([{ type: "stalled", silentMs: 1_000, capture: true }]);
  expect(seen.slice(0, 9).every((o) => o.type === "healthy")).toBe(true);
  expect(detector.observe(3_100, 2)).toEqual({ type: "recovered", silentMs: 3_100 });
  expect(detector.observe(3_200, 3)).toEqual({ type: "healthy" });
});

test("a long freeze is looked at again as it goes on, up to the capture limit", () => {
  const detector = createStallDetector(options);
  detector.observe(0, 1);
  const captured = silence(detector, 100, 30_000, 1).flatMap((o) =>
    o.type === "stalled" && o.capture ? [o.silentMs] : [],
  );
  expect(captured).toEqual([1_000, 6_000, 11_000]);
});

test("a short stall soon after a looked-at one is reported but not looked at again", () => {
  const detector = createStallDetector(options);
  detector.observe(0, 1);
  silence(detector, 100, 1_500, 1);
  detector.observe(1_600, 2);
  const second = silence(detector, 1_700, 4_000, 2);
  expect(second.some((o) => o.type === "stalled")).toBe(true);
  expect(second.some((o) => o.type === "stalled" && o.capture)).toBe(false);
  // Growing into a long freeze, it is looked at after all.
  const longer = silence(detector, 4_100, 7_000, 2);
  expect(longer.filter((o) => o.type === "stalled" && o.capture)).toEqual([
    { type: "stalled", silentMs: 5_000, capture: true },
  ]);
});

test("silence while the watchdog itself was not running (sleep, descheduling) is not a stall", () => {
  const detector = createStallDetector(options);
  detector.observe(0, 1);
  // The whole process paused for a minute: the next check is the first in 60 s.
  expect(detector.observe(60_000, 1)).toEqual({ type: "healthy" });
  expect(detector.observe(60_100, 2)).toEqual({ type: "healthy" });
});
