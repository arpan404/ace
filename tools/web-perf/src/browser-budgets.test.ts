import { retryTiming, TimingFailure } from "@ace/perf-kit";
import { reportBrowser } from "@ace/web-perf";
import { expect, test } from "vitest";

const healthy = {
  interactions: 100,
  p75: 40,
  p95: 40,
  longest: 0,
  longShare: 0,
  longCount: 0,
  seconds: 12,
};

test("4997.42 events/s is rejected and replaced only by a passing complete repeat", async () => {
  const samples = [4997.42, 5040][Symbol.iterator]();
  const accepted = await retryTiming(
    async () => {
      const throughput = samples.next().value ?? 0;
      reportBrowser(throughput, healthy);
      return throughput;
    },
    () => {},
  );
  expect(accepted).toBe(5040);
});

test("a repeated small throughput shortfall fails the gate", async () => {
  await expect(
    retryTiming(
      async () => {
        reportBrowser(4997.42, healthy);
      },
      () => {},
    ),
  ).rejects.toThrow(TimingFailure);
});

test("the documented 5000 events/s boundary passes", () => {
  expect(() => reportBrowser(5000, healthy)).not.toThrow();
});
