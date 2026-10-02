import { describe, expect, it } from "vitest";
import { query, setup } from "./test-support.ts";

describe("usage queries", () => {
  it("groups and filters every dimension, ranks top threads and marks truncated results", () => {
    const h = setup();
    h.thread();
    h.agent();
    h.thread("t2", "claude", "w2");
    h.agent("a2", null, "m2", "claude", "t2");
    h.usage(10, "root", { model: "m1", accountId: "acc1", costUsd: 4, counterMode: "incremental" });
    h.send(
      {
        type: "usage.updated",
        agentId: "a2",
        inputTokens: 20,
        outputTokens: 3,
        model: "m2",
        accountId: "acc2",
        costUsd: 1,
        counterMode: "incremental",
      },
      undefined,
      "t2",
    );
    const dims = ["day", "thread", "agent", "provider", "account", "model", "workspace"];
    for (const dim of dims) {
      const rows = h.store.summary({ ...query, groupBy: [dim] }).rows;
      expect(rows.reduce((n, r) => n + r.totals.inputTokens, 0)).toBe(30);
    }
    expect(h.store.summary({ ...query, groupBy: dims }).rows[0]?.dimensions).toEqual({
      day: "2026-10-02",
      thread: "t2",
      agent: "a2",
      provider: "claude",
      account: "acc2",
      model: "m2",
      workspace: "w2",
    });
    for (const [dim, value] of Object.entries({
      day: "2026-10-02",
      thread: "t2",
      agent: "a2",
      provider: "claude",
      account: "acc2",
      model: "m2",
      workspace: "w2",
    })) {
      expect(h.totals({ ...query, filters: { [dim]: [value] } }).inputTokens).toBe(
        dim === "day" ? 30 : 20,
      );
    }
    expect(h.store.summary({ ...query, groupBy: ["thread"], limit: 1 })).toMatchObject({
      truncated: true,
      rows: [{ dimensions: { thread: "t2" } }],
    });
    expect(
      h.store.summary({ ...query, groupBy: ["thread"], limit: 1, orderBy: "cost" }).rows[0]
        ?.dimensions.thread,
    ).toBe("thread");
    expect(
      h.totals({ ...query, filters: { account: ["acc2"], provider: ["codex"] } }).inputTokens,
    ).toBe(0);
  });
  it("unknown model and account groups are null and hostile filters remain values", () => {
    const h = setup();
    h.thread();
    h.agent("root", null, null);
    h.usage(1);
    expect(
      h.store.summary({ ...query, groupBy: ["model", "account"] }).rows[0]?.dimensions,
    ).toEqual({ model: null, account: null });
    expect(h.totals({ ...query, filters: { thread: ["' OR 1=1 --"] } }).inputTokens).toBe(0);
    expect(() => h.store.summary({ ...query, groupBy: ["sqlite_master"] })).toThrow();
    expect(() => h.store.summary({ ...query, to: "2027-12-31" })).toThrow();
  });
  it("day boundaries use local midnight across spring and autumn DST transitions", () => {
    const h = setup({ timezone: "America/New_York" });
    h.thread();
    h.agent();
    const instants = [
      "2026-03-08T04:59:59Z",
      "2026-03-08T05:00:00Z",
      "2026-03-08T06:59:59Z",
      "2026-03-08T07:00:00Z",
      "2026-03-09T03:59:59Z",
      "2026-03-09T04:00:00Z",
      "2026-11-01T03:59:59Z",
      "2026-11-01T04:00:00Z",
      "2026-11-01T05:30:00Z",
      "2026-11-01T06:30:00Z",
      "2026-11-02T04:59:59Z",
      "2026-11-02T05:00:00Z",
    ];
    for (const at of instants) h.usage(1, "root", { counterMode: "incremental" }, Date.parse(at));
    expect(
      h.store
        .series({ ...query, groupBy: ["provider"] })
        .rows.map((r) => [r.dimensions.day, r.totals.inputTokens]),
    ).toEqual([
      ["2026-03-07", 1],
      ["2026-03-08", 4],
      ["2026-03-09", 1],
      ["2026-10-31", 1],
      ["2026-11-01", 4],
      ["2026-11-02", 1],
    ]);
    expect(h.totals({ from: "2026-03-08", to: "2026-03-08" }).inputTokens).toBe(4);
  });
  it("burn rates include only the account and exact quota window and distinguish zero reported dollars", () => {
    const h = setup();
    h.thread();
    h.agent();
    const at = Date.parse("2026-10-02T12:00Z");
    h.usage(100, "root", { accountId: "acc", counterMode: "incremental" }, at - 1);
    h.usage(40, "root", { accountId: "acc", counterMode: "incremental" }, at);
    h.usage(20, "root", { accountId: "acc", counterMode: "incremental" }, at + 3_600_000);
    h.usage(200, "root", { accountId: "other", counterMode: "incremental" }, at);
    h.usage(
      1_000_000,
      "root",
      { accountId: "free", billingMode: "api", costUsd: 0, counterMode: "incremental" },
      at,
    );
    const window = { id: "5h", unit: "tokens", start: at, end: at + 5 * 3_600_000, remaining: 80 };
    expect(h.store.burn("acc", window, at + 2 * 3_600_000)).toEqual({
      windowId: "5h",
      unit: "tokens",
      observed: 60,
      perHour: 30,
      remaining: 80,
      exhaustionAt: at + (2 + 80 / 30) * 3_600_000,
    });
    expect(h.store.burn("free", { ...window, unit: "usd" }, at + 3_600_000).observed).toBe(0);
    expect(h.store.burn("acc", window, at).perHour).toBe(0);
    expect(h.store.burn("acc", window, window.end).exhaustionAt).toBeNull();
    expect(() => h.store.burn("acc", { ...window, unit: "percent" }, at)).toThrow();
  });
  it("cross-thread parents and ancestor cycles cannot corrupt inclusive totals", () => {
    const h = setup();
    h.thread();
    h.agent();
    h.agent("child", "root");
    expect(() => h.send({ type: "agent.updated", id: "root", parent: "child" })).toThrow("cycle");
    // Failed transaction did not advance the persisted cursor. Use its cursor for a new public batch.
    const cursor = h.store.cursor();
    h.store.ingest({
      afterSeq: cursor,
      throughSeq: cursor + 1,
      events: [
        {
          seq: cursor + 1,
          at: 1,
          threadId: "other",
          payload: { type: "thread.created", workspace: "w", provider: "claude" },
        },
      ],
    });
    expect(() =>
      h.store.ingest({
        afterSeq: cursor + 1,
        throughSeq: cursor + 2,
        events: [
          {
            seq: cursor + 2,
            at: 1,
            threadId: "other",
            payload: {
              type: "agent.created",
              id: "other-agent",
              parent: "root",
              model: null,
              provider: "claude",
            },
          },
        ],
      }),
    ).toThrow("Cross-thread");
  });
});
