import { expect, test } from "vitest";
import { query, setup } from "./test-support.ts";

// claude-sonnet-4-6 lists $3 input, $0.30 cache read, $3.75 cache write and $15 output per million.
test("the API estimate splits by token type and reports what cache reads saved", () => {
  const h = setup();
  h.thread();
  h.agent();
  h.usage(1_000_000, "root", {
    model: "claude-sonnet-4-6",
    cachedInputTokens: 600_000,
    cacheWriteTokens: 100_000,
    outputTokens: 200_000,
    counterMode: "incremental",
  });
  const totals = h.totals({ ...query, equivalentApiCost: true });
  expect(totals.apiInputUsd).toBeCloseTo(0.9);
  expect(totals.apiCacheReadUsd).toBeCloseTo(0.18);
  expect(totals.apiCacheWriteUsd).toBeCloseTo(0.375);
  expect(totals.apiOutputUsd).toBeCloseTo(3);
  expect(totals.equivalentApiUsd).toBeCloseTo(4.455);
  expect(totals.cacheSavingsUsd).toBeCloseTo(1.62);
});

test("unpriced models add tokens but nothing to the split", () => {
  const h = setup();
  h.thread();
  h.agent("root", null, "unlisted-model");
  h.usage(1_000_000, "root", {
    model: "unlisted-model",
    cachedInputTokens: 500_000,
    counterMode: "incremental",
  });
  const totals = h.totals({ ...query, equivalentApiCost: true });
  expect(totals.unpricedTokens).toBe(1_000_000);
  expect(totals.equivalentApiUsd).toBeNull();
  expect(totals.apiInputUsd).toBe(0);
  expect(totals.cacheSavingsUsd).toBe(0);
});
