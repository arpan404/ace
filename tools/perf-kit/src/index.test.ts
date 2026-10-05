import { expect, test } from "vitest";
import { retryTiming, TimingFailure } from "@ace/perf-kit";

test("one timing outlier is reported before accepting the next complete measurement", async () => {
  const samples: Array<number | Error> = [new TimingFailure("243 events/s"), 390];
  const diagnostics: string[] = [];
  const result = await retryTiming(
    async () => {
      const sample = samples.shift();
      if (sample instanceof Error) throw sample;
      return sample;
    },
    (error) => diagnostics.push(error.message),
  );
  expect(result).toBe(390);
  expect(diagnostics).toEqual(["243 events/s"]);
});

test("a persistent timing regression remains a failure after its second measurement", async () => {
  const first = new TimingFailure("243 events/s");
  const second = new TimingFailure("260 events/s");
  const samples = [first, second];
  const diagnostics: string[] = [];
  await expect(
    retryTiming(
      async () => {
        throw samples.shift();
      },
      (error) => {
        diagnostics.push(error.message);
      },
    ),
  ).rejects.toBe(second);
  expect(diagnostics).toEqual([first.message]);
});

test("a resource or correctness failure cannot be replaced by a passing measurement", async () => {
  const failure = new Error("lost or duplicated deltas");
  const samples: Array<number | Error> = [failure, 390];
  const diagnostics: string[] = [];
  await expect(
    retryTiming(
      async () => {
        const sample = samples.shift();
        if (sample instanceof Error) throw sample;
        return sample;
      },
      (error) => diagnostics.push(error.message),
    ),
  ).rejects.toBe(failure);
  expect(diagnostics).toEqual([]);
});

test("a correctness failure in the repeat fails the gate", async () => {
  const failure = new Error("oversized client frame");
  const samples = [new TimingFailure("deadline"), failure];
  await expect(
    retryTiming(
      async () => {
        throw samples.shift();
      },
      () => {},
    ),
  ).rejects.toBe(failure);
});
