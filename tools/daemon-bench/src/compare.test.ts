import { expect, test } from "vitest";
import {
  adopt,
  Baseline,
  combine,
  compare,
  median,
  staleBaselines,
  type Measured,
} from "./compare.ts";
import { BenchResult } from "./result.ts";
import { standardOptions, WorkloadMismatch, type Workload } from "./workload.ts";

const standard: Workload = {
  version: 1,
  options: standardOptions,
  fixtures: { "tool-read.jsonl": "aaaa" },
};
const shortened: Workload = { ...standard, options: { ...standardOptions, seedThreads: 20 } };
const baseline = Baseline.parse({
  version: 2,
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
      workload: standard,
      metrics: {
        "phases.newThreads.transactionsPerTurn": 100,
        "phases.newThreads.cpuPerTurn": 5,
        "idle.cpuPerMinute": 1,
        "startup.rss": 200_000_000,
      },
    },
  },
});
const measured = (
  metrics: Record<string, number>,
  platform = "darwin-arm64",
  workload = standard,
): Measured => ({ platform, node: "v24.0.0", runs: 3, workload, metrics });
const status = (metrics: Record<string, number>) =>
  Object.fromEntries(compare(measured(metrics), baseline).map((v) => [v.metric, v.status]));
const memory = { heapUsed: 1, rss: 1 };
const phase = {
  turns: 1,
  wallMs: 1,
  cpuMsPerTurn: 1,
  cpuPerTurn: 1,
  transactionsPerTurn: 1,
  memory,
};
const result = (workload: Workload, transactions: number, platform = "darwin-arm64") =>
  BenchResult.parse({
    version: 2,
    platform,
    node: "v24.0.0",
    workload,
    calibrationMs: 50,
    startup: memory,
    idle: { seconds: 60, cpuPercent: 1, cpuPerMinute: 1, memory },
    phases: {
      newThreads: { ...phase, transactionsPerTurn: transactions },
      sameThread: phase,
      longText: phase,
    },
  });

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
    measured(
      { "phases.newThreads.transactionsPerTurn": 130, "startup.rss": 900_000_000 },
      "linux-x64",
    ),
    baseline,
  );
  expect(verdicts.map((v) => [v.metric, v.status, v.from])).toEqual([
    ["phases.newThreads.transactionsPerTurn", "regressed", "darwin-arm64"],
    ["startup.rss", "unbaselined", undefined],
  ]);
});

test("metrics without a tolerance are not gated", () => {
  expect(compare(measured({ "phases.newThreads.wallMs": 99_999 }), baseline)).toEqual([]);
});

test("the median of repeated runs ignores one slow run", () => {
  expect(median([{ cpu: 5 }, { cpu: 50 }, { cpu: 6 }])).toEqual({ cpu: 6 });
  expect(median([{ cpu: 4 }, { cpu: 6 }])).toEqual({ cpu: 5 });
});

test("a run with fewer seeded threads is refused rather than compared with the full workload", () => {
  // Fewer threads would pass easily; the gate must not report it as a pass.
  const short = measured(
    { "phases.newThreads.transactionsPerTurn": 100 },
    "darwin-arm64",
    shortened,
  );
  expect(() => compare(short, baseline)).toThrow(WorkloadMismatch);
  expect(() => compare(short, baseline)).toThrow("seedThreads 400 → 20");
});

test("a platform without its own baseline refuses another platform's baseline of a different workload", () => {
  const noDeltas = { ...standard, options: { ...standardOptions, longTextDeltas: 0 } };
  expect(() =>
    compare(measured({ "phases.longText.cpuPerTurn": 1 }, "linux-x64", noDeltas), baseline),
  ).toThrow("longTextDeltas 1000 → 0");
});

test("a baseline whose recording changed is refused even when every option matches", () => {
  const edited = { ...standard, fixtures: { "tool-read.jsonl": "bbbb" } };
  expect(() => compare(measured({}, "darwin-arm64", edited), baseline)).toThrow(
    "fixture tool-read.jsonl aaaa → bbbb",
  );
  const newer = { ...standard, version: 2 };
  expect(() => compare(measured({}, "darwin-arm64", newer), baseline)).toThrow("version 1 → 2");
});

test("runs of different workloads are not combined into one median", () => {
  expect(() => combine([result(standard, 100), result(shortened, 10)])).toThrow(
    "Run 2 measured a different workload from run 1: seedThreads 400 → 20",
  );
  expect(() => combine([result(standard, 100), result(standard, 100, "linux-x64")])).toThrow(
    "one platform",
  );
});

test("runs of one workload combine into medians that keep the workload", () => {
  const combined = combine([result(standard, 100), result(standard, 300), result(standard, 120)]);
  expect(combined.workload).toEqual(standard);
  expect(combined.metrics["phases.newThreads.transactionsPerTurn"]).toBe(120);
});

test("only the standard workload can become a baseline", () => {
  const short = combine([result(shortened, 10)]);
  expect(() => adopt(baseline, { ...short, platform: "linux-x64" }, standard)).toThrow(
    "Refusing to adopt results that did not run the standard workload: seedThreads 400 → 20",
  );
  const full = combine([result(standard, 140, "linux-x64")]);
  const updated = adopt(baseline, full, standard);
  expect(updated.platforms["linux-x64"]?.metrics["phases.newThreads.transactionsPerTurn"]).toBe(
    140,
  );
  expect(updated.platforms["darwin-arm64"]).toEqual(baseline.platforms["darwin-arm64"]);
});

test("adopting a new standard names the platforms still measured with the old one", () => {
  const changed = { ...standard, options: { ...standardOptions, newThreads: 30 } };
  const updated = adopt(baseline, combine([result(changed, 140, "linux-x64")]), changed);
  expect(staleBaselines(updated, changed)).toEqual(["darwin-arm64"]);
});
