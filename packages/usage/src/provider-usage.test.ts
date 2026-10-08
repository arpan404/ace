import { expect, it } from "vitest";
import { UsageStore, UsageEvent, estimateTokens, defaultPrices } from "./index.ts";
import { setup, query } from "./test-support.ts";

it("account and model series equal a full replay, with cache prices and subscription separation", () => {
  const h = setup();
  const events: UsageEvent[] = [h.thread(), h.agent()];
  events.push(
    h.usage(1_000_000, "root", {
      outputTokens: 100_000,
      cachedInputTokens: 200_000,
      cacheWriteTokens: 100_000,
      cacheWrite1hTokens: 40_000,
      reasoningTokens: 20_000,
      accountId: "api",
      billingMode: "api",
      counterMode: "cumulative",
      counterKey: "session",
    }),
  );
  events.push(
    h.usage(
      1_200_000,
      "root",
      {
        outputTokens: 150_000,
        cachedInputTokens: 300_000,
        cacheWriteTokens: 100_000,
        cacheWrite1hTokens: 40_000,
        reasoningTokens: 30_000,
        accountId: "api",
        billingMode: "api",
        counterMode: "cumulative",
        counterKey: "session",
      },
      Date.parse("2026-10-03T12:00Z"),
    ),
  );
  events.push(
    h.usage(10, "root", {
      accountId: "plan",
      billingMode: "subscription",
      costUsd: 50,
      counterMode: "incremental",
    }),
  );
  events.push(
    h.usage(40, "root", {
      accountId: "api",
      model: "unlisted",
      billingMode: "api",
      counterMode: "incremental",
    }),
  );
  const full = new UsageStore(":memory:");
  try {
    full.ingest({ afterSeq: 0, throughSeq: events.length, events });
    const q = { ...query, groupBy: ["account", "model"], equivalentApiCost: true };
    expect(h.store.series(q)).toEqual(full.series(q));
    const api = h.store.summary({
      ...q,
      filters: { account: ["api"], model: ["claude-sonnet-4-6"] },
    }).rows[0]?.totals;
    expect(api).toMatchObject({
      inputTokens: 1_200_000,
      outputTokens: 150_000,
      reasoningTokens: 30_000,
      cachedInputTokens: 300_000,
    });
    // 800k regular input, 300k cache hits, 60k short writes, 40k long writes, 150k output.
    expect(api?.estimatedUsd).toBeCloseTo(5.205);
    expect(
      estimateTokens(
        {
          input: 1_200_000,
          output: 150_000,
          cached: 300_000,
          reasoning: 30_000,
          write: 100_000,
          write1h: 40_000,
          cost: 0,
        },
        "claude-sonnet-4-6",
      ),
    ).toBeCloseTo(5.205);
    const plan = h.store.summary({ ...query, filters: { account: ["plan"] } }).rows[0]?.totals;
    expect(plan).toMatchObject({ estimatedUsd: 0, providerReportedUsd: 0, subscriptionTokens: 10 });
    const unknown = h.store.summary({ ...query, filters: { model: ["unlisted"] } }).rows[0]?.totals;
    expect(unknown).toMatchObject({ inputTokens: 40, estimatedUsd: 0, unpricedTokens: 40 });
    expect(
      estimateTokens(
        { input: 40, output: 0, cached: 0, reasoning: 0, write: 0, write1h: 0, cost: 0 },
        "unlisted",
      ),
    ).toBeNull();
    expect(h.store.summary(query)).toMatchObject({
      priceVersion: defaultPrices.version,
      priceAsOf: "2026-10-07",
      costLabel: "estimate",
    });
  } finally {
    full.close();
  }
});

it("week and month charts aggregate local days per account without crossing filters", () => {
  const h = setup();
  h.thread();
  h.agent();
  for (const [day, input] of [
    ["2026-09-30", 10],
    ["2026-10-01", 20],
    ["2026-10-04", 30],
    ["2026-10-05", 40],
  ] as const)
    h.usage(
      input,
      "root",
      { counterMode: "incremental", accountId: "a" },
      Date.parse(`${day}T12:00Z`),
    );
  h.usage(999, "root", { counterMode: "incremental", accountId: "b" });
  const q = {
    from: "2026-09-30",
    to: "2026-10-05",
    groupBy: ["account"],
    filters: { provider: ["codex"], account: ["a"] },
  };
  expect(
    h.store
      .series({ ...q, bucket: "week" })
      .rows.map((r) => [r.dimensions.day, r.totals.inputTokens]),
  ).toEqual([
    ["2026-09-28", 60],
    ["2026-10-05", 40],
  ]);
  expect(
    h.store
      .series({ ...q, bucket: "month" })
      .rows.map((r) => [r.dimensions.day, r.totals.inputTokens]),
  ).toEqual([
    ["2026-09-01", 10],
    ["2026-10-01", 90],
  ]);
  expect(
    h.store.series({ ...q, groupBy: [], bucket: "week" }).rows.map((r) => r.totals.inputTokens),
  ).toEqual([60, 40]);
});

it("history and exact-window storage expire while cumulative baselines survive restart", () => {
  const h = setup({ retentionDays: 2, incrementRetentionDays: 1 });
  h.thread();
  h.agent();
  const at = Date.parse("2026-10-01T12:00Z");
  for (let day = 0; day < 10; day++)
    h.usage(
      (day + 1) * 100,
      "root",
      { accountId: "a", counterMode: "cumulative", counterKey: "long-session" },
      at + day * 86_400_000,
    );
  expect(h.store.series(query).rows.map((r) => [r.dimensions.day, r.totals.inputTokens])).toEqual([
    ["2026-10-09", 100],
    ["2026-10-10", 100],
  ]);
  expect(
    h.store.burn(
      "a",
      { id: "old", unit: "tokens", start: at, end: at + 11 * 86_400_000, remaining: 1000 },
      at + 10 * 86_400_000,
    ),
  ).toMatchObject({ observed: 200, complete: false, exhaustionAt: null });
  h.reopen();
  h.usage(
    1100,
    "root",
    { accountId: "a", counterMode: "cumulative", counterKey: "long-session" },
    at + 10 * 86_400_000,
  );
  expect(h.store.series(query).rows.map((r) => r.totals.inputTokens)).toEqual([100, 100]);
  expect(h.store.summary(query).retainedFrom).toBe("2026-10-10");
});
