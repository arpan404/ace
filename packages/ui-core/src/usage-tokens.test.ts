import type { UsageRow, UsageTotals } from "@ace/protocol";
import { expect, test } from "vitest";
import { rankBreakdown, usageQueryFilters } from "./usage-breakdown.ts";
import { evenLeftPercent, windowRunsOutAt } from "./usage-limits.ts";
import { usageReport } from "./usage-report.ts";
import { tokenTable } from "./usage-tokens.ts";

const totals = (over: Partial<UsageTotals>): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  providerReportedUsd: 0,
  estimatedUsd: 0,
  equivalentApiUsd: 0,
  overflow: false,
  unpricedTokens: 0,
  subscriptionTokens: 0,
  unknownBillingTokens: 0,
  ...over,
});

const row = (dimensions: UsageRow["dimensions"], over: Partial<UsageTotals>): UsageRow => ({
  dimensions,
  totals: totals(over),
});

// 1,000 input (600 cache reads, 150 cache writes of which 50 for an hour, 250 uncached) and 400
// output, of which 100 reasoning. Output costs $4: reasoning is a quarter of it.
const day = row(
  { day: "2026-11-01", provider: "claude" },
  {
    inputTokens: 1000,
    outputTokens: 400,
    cachedInputTokens: 600,
    cacheWriteTokens: 150,
    cacheWrite1hTokens: 50,
    reasoningTokens: 100,
    apiInputUsd: 1,
    apiCacheReadUsd: 0.5,
    apiCacheWriteUsd: 1.5,
    apiOutputUsd: 4,
    cacheSavingsUsd: 2,
    subscriptionTokens: 1050,
    estimatedUsd: 1.75,
  },
);

const table = () =>
  tokenTable(
    usageReport(
      [{ daily: [day], models: [], threads: [], threadsTruncated: false }],
      ["2026-11-01"],
    ),
  );

test("the token table adds up to every processed token and the whole cost, once each", () => {
  const result = table();
  expect(result.rows.map((entry) => [entry.label, entry.tokens])).toEqual([
    ["Cache reads", 600],
    ["Cache writes", 150],
    ["Uncached input", 250],
    ["Output", 300],
    ["Reasoning", 100],
  ]);
  expect(result.tokens).toBe(1400);
  expect(result.usd).toBeCloseTo(7);
  expect(result.rows.reduce((sum, entry) => sum + entry.costShare, 0)).toBeCloseTo(1);
});

test("reasoning is priced as part of output and never counted on top of it", () => {
  const result = table();
  const output = result.rows.find((entry) => entry.kind === "output");
  const reasoning = result.rows.find((entry) => entry.kind === "reasoning");
  expect(reasoning?.usd).toBeCloseTo(1);
  expect(output?.usd).toBeCloseTo(3);
  expect(reasoning?.detail).toBe("billedAsOutput");
});

test("cache writes split into five-minute and one-hour writes, and the totals below the table", () => {
  const result = table();
  expect(result.rows.find((entry) => entry.kind === "cacheWrite")?.detail).toEqual({
    cacheWrite5m: 100,
    cacheWrite1h: 50,
  });
  expect(result.cacheHitRate).toBeCloseTo(0.6);
  expect(result.cacheSavingsUsd).toBe(2);
  expect(result.subscriptionShare).toBeCloseTo(0.75);
  expect(result.apiBilledUsd).toBe(1.75);
});

test("a window's even-pace tick and its run-out time follow the time it has run", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");
  const minute = 60_000;
  // Three of five hours gone: even pace leaves 40%.
  expect(evenLeftPercent(now + 120 * minute, 300, now)).toBe(40);
  // 80% used in three hours: the rest goes in 45 minutes, before the reset.
  expect(windowRunsOutAt(80, now + 120 * minute, 300, now)).toBe(now + 45 * minute);
  // 30% used in three hours lasts until the reset.
  expect(windowRunsOutAt(30, now + 120 * minute, 300, now)).toBeNull();
  expect(windowRunsOutAt(30, null, 300, now)).toBeNull();
});

test("a breakdown sums every machine's rows per value and ranks by cost", () => {
  const mac = [
    row({ skill: "release" }, { inputTokens: 100, apiInputUsd: 1 }),
    row({ skill: "review" }, { inputTokens: 900, apiInputUsd: 0.5 }),
    row({ skill: null }, { inputTokens: 5000, apiInputUsd: 9 }),
  ];
  const studio = [row({ skill: "review" }, { inputTokens: 100, apiInputUsd: 1 })];
  expect(rankBreakdown([mac, studio], "skill")).toEqual([
    { key: "review", tokens: 1000, usd: 1.5, unpricedTokens: 0 },
    { key: "release", tokens: 100, usd: 1, unpricedTokens: 0 },
  ]);
});

test("clicking a breakdown row filters usage queries by its dimension; a machine picks daemons", () => {
  expect(usageQueryFilters({ kind: "skill", key: "release", label: "release" })).toEqual({
    skill: ["release"],
  });
  expect(usageQueryFilters({ kind: "machine", key: "studio", label: "Studio" })).toEqual({});
  expect(usageQueryFilters(undefined)).toEqual({});
});

test("reasoning priced at its own rate is taken out of output's cost, not added to it", () => {
  const priced = row(
    { day: "2026-11-01", provider: "claude" },
    {
      inputTokens: 100,
      outputTokens: 400,
      reasoningTokens: 100,
      apiInputUsd: 1,
      apiOutputUsd: 4,
      // Reasoning costs twice output's rate here: $2 of the $4.
      apiReasoningUsd: 2,
    },
  );
  const result = tokenTable(
    usageReport(
      [{ daily: [priced], models: [], threads: [], threadsTruncated: false }],
      ["2026-11-01"],
    ),
  );
  expect(result.rows.find((entry) => entry.kind === "reasoning")?.usd).toBeCloseTo(2);
  expect(result.rows.find((entry) => entry.kind === "output")?.usd).toBeCloseTo(2);
  expect(result.usd).toBeCloseTo(5);
});
