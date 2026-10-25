import { expect, test } from "vitest";
import { Baseline, compare, median } from "./compare.ts";

const baseline = Baseline.parse({
  version: 1,
  tolerances: [
    { metric: "phases.*.transactionsPerTurn", relative: 0.1, absolute: 2, portable: true },
    { metric: "phases.*.cpuPerTurn", relative: 0.4, portable: true },
    { metric: "idle.cpuPerMinute", relative: 0.5, absolute: 3 },
    { metric: "startup.rss", relative: 0.15 },
  ],
  platforms: {
    "darwin-arm64": {
      node: "v24.0.0",
      runs: 3,
      metrics: {
        "phases.newThreads.transactionsPerTurn": 100,
        "phases.newThreads.cpuPerTurn": 5,
        "idle.cpuPerMinute": 1,
        "startup.rss": 200_000_000,
      },
    },
  },
});
const status = (actual: Record<string, number>, platform = "darwin-arm64") =>
  Object.fromEntries(compare(actual, baseline, platform).map((v) => [v.metric, v.status]));

test("growth beyond tolerance regresses while growth within it passes", () => {
  expect(
    status({
      "phases.newThreads.transactionsPerTurn": 111,
      "phases.newThreads.cpuPerTurn": 6.9,
    }),
  ).toEqual({
    "phases.newThreads.transactionsPerTurn": "regressed",
    "phases.newThreads.cpuPerTurn": "pass",
  });
});

test("an absolute floor keeps a near-zero metric from failing on noise", () => {
  expect(status({ "idle.cpuPerMinute": 3.5 })).toEqual({ "idle.cpuPerMinute": "pass" });
  expect(status({ "idle.cpuPerMinute": 4.5 })).toEqual({ "idle.cpuPerMinute": "regressed" });
});

test("a large drop is reported as an improvement rather than a failure", () => {
  expect(status({ "phases.newThreads.transactionsPerTurn": 50 })).toEqual({
    "phases.newThreads.transactionsPerTurn": "improved",
  });
});

test("another platform gates only portable metrics against the baseline it has", () => {
  const verdicts = compare(
    { "phases.newThreads.transactionsPerTurn": 130, "startup.rss": 900_000_000 },
    baseline,
    "linux-x64",
  );
  expect(verdicts.map((v) => [v.metric, v.status, v.from])).toEqual([
    ["phases.newThreads.transactionsPerTurn", "regressed", "darwin-arm64"],
    ["startup.rss", "unbaselined", undefined],
  ]);
});

test("metrics without a tolerance are not gated", () => {
  expect(compare({ "phases.newThreads.wallMs": 99_999 }, baseline, "darwin-arm64")).toEqual([]);
});

test("the median of repeated runs ignores one slow run", () => {
  expect(median([{ cpu: 5 }, { cpu: 50 }, { cpu: 6 }])).toEqual({ cpu: 6 });
  expect(median([{ cpu: 4 }, { cpu: 6 }])).toEqual({ cpu: 5 });
});
