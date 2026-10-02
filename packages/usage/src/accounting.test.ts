import { describe, expect, it } from "vitest";
import { query, setup } from "./test-support.ts";

describe("usage accounting", () => {
  it("parents include every descendant once while thread totals remain additive", () => {
    const h = setup();
    h.thread();
    h.agent();
    h.agent("child", "root");
    h.agent("grandchild", "child");
    h.usage(10);
    h.usage(20, "child");
    h.usage(30, "grandchild");
    expect(h.totals().inputTokens).toBe(60);
    expect(h.totals({ ...query, agentTree: "root" }).inputTokens).toBe(60);
    expect(h.totals({ ...query, agentTree: "child" }).inputTokens).toBe(50);
    expect(
      h.store
        .summary({ ...query, groupBy: ["agent"] })
        .rows.map((r) => [r.dimensions.agent, r.totals.inputTokens]),
    ).toEqual([
      ["grandchild", 30],
      ["child", 20],
      ["root", 10],
    ]);
  });
  it("late linking attributes earlier usage and reparenting removes it from the old subtree", () => {
    const h = setup();
    h.thread();
    h.agent();
    h.agent("other");
    h.agent("child");
    h.usage(9, "child");
    h.send({ type: "agent.updated", id: "child", parent: "root" });
    expect(h.totals({ ...query, agentTree: "root" }).inputTokens).toBe(9);
    h.send({ type: "agent.updated", id: "child", parent: "other" });
    expect(h.totals({ ...query, agentTree: "root" }).inputTokens).toBe(0);
    expect(h.totals({ ...query, agentTree: "other" }).inputTokens).toBe(9);
  });
  it("cumulative replays and regressions add nothing and a new session starts a fresh counter", () => {
    const h = setup();
    h.thread();
    h.agent();
    h.usage(20, "root", {
      outputTokens: 7,
      cachedInputTokens: 4,
      reasoningTokens: 3,
      costUsd: 0.2,
      counterKey: "s1",
    });
    h.usage(20, "root", { outputTokens: 7, counterKey: "s1" });
    h.usage(10, "root", { outputTokens: 2, counterKey: "s1" });
    h.usage(25, "root", { outputTokens: 9, counterKey: "s1" });
    h.usage(6, "root", { outputTokens: 1, counterKey: "s2" });
    expect(h.totals()).toMatchObject({
      inputTokens: 31,
      outputTokens: 10,
      cachedInputTokens: 4,
      reasoningTokens: 3,
      providerReportedUsd: 0.2,
    });
  });
  it("unkeyed increments add and keyed immutable samples deduplicate across reconnects", () => {
    const h = setup();
    h.thread();
    h.agent();
    h.usage(4, "root", { counterMode: "incremental" });
    h.usage(4, "root", { counterMode: "incremental" });
    h.usage(10, "root", { counterMode: "incremental", counterKey: "sample" });
    h.reopen();
    h.usage(10, "root", { counterMode: "incremental", counterKey: "sample" });
    expect(h.totals().inputTokens).toBe(18);
  });
  it("Claude legacy cumulative counters reset at canonical run boundaries", () => {
    const h = setup();
    h.thread("thread", "claude");
    h.agent("root", null, null, "claude");
    h.send({ type: "run.started", agent: "root", run: "r1" });
    h.usage(10, "root", { cachedInputTokens: 3 });
    h.usage(10, "root", { cachedInputTokens: 3 });
    h.send({ type: "run.started", agent: "root", run: "r2" });
    h.usage(5);
    expect(h.totals().inputTokens).toBe(18);
  });
  it("prices separate reported dollars from API estimates without billing cache or reasoning twice", () => {
    const h = setup();
    h.thread();
    h.agent();
    h.usage(1_000_000, "root", {
      outputTokens: 100_000,
      cachedInputTokens: 200_000,
      cacheWriteTokens: 100_000,
      cacheWrite1hTokens: 20_000,
      reasoningTokens: 50_000,
      costUsd: 7,
      billingMode: "api",
      counterMode: "incremental",
    });
    expect(h.totals({ ...query, equivalentApiCost: true })).toMatchObject({
      providerReportedUsd: 7,
      estimatedUsd: 4.08,
      equivalentApiUsd: 4.08,
    });
  });
  it("subscription usage has tokens and optional equivalent cost but no billed dollars", () => {
    const h = setup();
    h.thread();
    h.agent();
    h.usage(1_000_000, "root", { billingMode: "subscription", costUsd: 100 });
    expect(h.totals()).toMatchObject({
      providerReportedUsd: 0,
      estimatedUsd: 0,
      subscriptionTokens: 1_000_000,
      equivalentApiUsd: null,
    });
    expect(h.totals({ ...query, equivalentApiCost: true }).equivalentApiUsd).toBe(3);
  });
  it("unknown models and unknown billing remain explicit rather than becoming free or guessed invoices", () => {
    const h = setup();
    h.thread();
    h.agent();
    h.usage(20, "root", { model: "unlisted", billingMode: "api" });
    h.usage(30, "root", { counterKey: "unknown" });
    expect(h.totals({ ...query, equivalentApiCost: true })).toMatchObject({
      inputTokens: 50,
      unpricedTokens: 20,
      unknownBillingTokens: 30,
      estimatedUsd: 0,
      equivalentApiUsd: null,
    });
  });
  it("price overrides revalue history and preserve provider costs and the recorded timezone", () => {
    const h = setup();
    h.thread();
    h.agent();
    h.usage(1_000_000, "root", { billingMode: "api", costUsd: 8 });
    h.reopen({
      priceOverrides: {
        "claude-sonnet-4-6": { input: 2, output: 4, cached: 0.1, write: 2.5, write1h: 4 },
      },
      overrideVersion: "contract-v2",
    });
    expect(h.totals()).toMatchObject({ providerReportedUsd: 8, estimatedUsd: 2 });
    expect(h.store.summary(query).priceVersion).toBe("2026-10-02.1/contract-v2");
  });
  it("a failed transaction rolls back counters, rollups and replay progress", () => {
    const h = setup();
    h.thread();
    h.agent();
    const cursor = h.store.cursor();
    expect(() =>
      h.store.ingest({
        afterSeq: cursor,
        throughSeq: cursor + 2,
        events: [
          {
            seq: cursor + 1,
            at: Date.parse("2026-10-02"),
            threadId: "thread",
            payload: { type: "usage.updated", agentId: "root", inputTokens: 10, outputTokens: 0 },
          },
          {
            seq: cursor + 2,
            at: Date.parse("2026-10-02"),
            threadId: "thread",
            payload: { type: "agent.updated", id: "root", parent: "root" },
          },
        ],
      }),
    ).toThrow("cycle");
    expect(h.store.cursor()).toBe(cursor);
    expect(h.totals().inputTokens).toBe(0);
    h.usage(10);
    expect(h.totals().inputTokens).toBe(10);
  });
});
