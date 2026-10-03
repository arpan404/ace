import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { EventPayload, ThreadId } from "@ace/protocol";
import { UsageStore, backfillBatch } from "@ace/usage";
import { Store } from "./store.ts";

const query = { from: "2026-01-01", to: "2026-12-31", groupBy: ["thread"] };
const at = Date.parse("2026-10-02T12:00Z");
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ace-usage-replay-"));
  let history = new Store(join(home, "events.sqlite"), undefined, { now: () => at });
  let usage = new UsageStore(join(home, "usage.sqlite"));
  const workspace = history.createWorkspace("/repo", "Repo");
  const add = (id: string, model = "claude-sonnet-4-6", large = "") => {
    const threadId = ThreadId.parse(id);
    history.appendEvents(
      threadId,
      [
        EventPayload.parse({
          type: "thread.created",
          thread: {
            id,
            workspaceId: workspace,
            provider: "codex",
            title: large || id,
            status: { state: "new" },
            createdAt: at,
            updatedAt: at,
          },
        }),
      ],
      at,
    );
    history.appendEvents(
      threadId,
      [
        EventPayload.parse({
          type: "agent.created",
          agent: {
            id: `${id}-agent`,
            threadId,
            parentId: null,
            native: { provider: "codex", id: large || "native" },
            origin: "root",
            fidelity: "full",
            cwd: large || "/repo",
            model,
            status: { state: "idle" },
            createdAt: at,
          },
        }),
      ],
      at,
    );
    history.appendEvents(
      threadId,
      [
        EventPayload.parse({
          type: "usage.updated",
          agentId: `${id}-agent`,
          inputTokens: 10,
          outputTokens: 2,
          accountId: "account",
        }),
      ],
      at,
    );
    return threadId;
  };
  const replay = async () => {
    const sink = {
      async cursor() {
        return usage.cursor();
      },
      async ingest(batch: unknown) {
        return usage.ingest(batch);
      },
    };
    while (await backfillBatch(sink, history)) {
      /* Public replay commits its own coverage. */
    }
  };
  return {
    add,
    replay,
    get history() {
      return history;
    },
    get usage() {
      return usage;
    },
    reopen() {
      usage.close();
      history.close();
      history = new Store(join(home, "events.sqlite"), undefined, { now: () => at });
      usage = new UsageStore(join(home, "usage.sqlite"));
    },
    rebuild() {
      usage.close();
      usage = new UsageStore(":memory:");
    },
    close() {
      usage.close();
      history.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
it("retained long models do not stall replay for other threads and stay filterable", async () => {
  const f = fixture();
  try {
    const model = "m".repeat(513);
    const first = f.add("long", model);
    f.history.appendEvents(
      first,
      [EventPayload.parse({ type: "agent.updated", agentId: "long-agent", model })],
      at,
    );
    f.add("healthy");
    await f.replay();
    expect(f.usage.cursor()).toBe(f.history.headSeq());
    expect(f.usage.summary(query).rows.map((row) => row.totals.inputTokens)).toEqual([10, 10]);
    expect(
      f.usage.summary({ ...query, filters: { model: [model] } }).rows[0]?.dimensions.thread,
    ).toBe("long");
  } finally {
    f.close();
  }
});
it("replay excludes large retained metadata and enforces its byte budget before advancing coverage", async () => {
  const f = fixture();
  try {
    f.add("large", "m".repeat(2 * 1024 * 1024), "private".repeat(300_000));
    for (let i = 0; i < 20; i++) f.add(`medium-${i}`, "m".repeat(8000));
    f.add("healthy");
    let afterSeq = 0;
    let pages = 0;
    while (afterSeq < f.history.headSeq()) {
      const page = f.history.readUsagePage({ afterSeq, limit: 256, maxBytes: 16 * 1024 });
      expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThanOrEqual(16 * 1024);
      expect(page.throughSeq).toBeGreaterThan(afterSeq);
      expect(JSON.stringify(page.events)).not.toContain("privateprivate");
      afterSeq = page.throughSeq;
      pages++;
    }
    expect(pages).toBeGreaterThan(1);
    await f.replay();
    expect(f.usage.summary(query).rows.reduce((sum, row) => sum + row.totals.inputTokens, 0)).toBe(
      220,
    );
    expect(
      f.usage.summary({ ...query, filters: { thread: ["large"] } }).rows[0]?.totals.unpricedTokens,
    ).toBe(12);
  } finally {
    f.close();
  }
});
it("thread deletion is durable and removes rollups, counters and quota observations across restart and rebuild", async () => {
  const f = fixture();
  try {
    const deleted = f.add("deleted");
    f.add("kept");
    await f.replay();
    const window = { id: "window", unit: "tokens", start: at - 1, end: at + 1000, remaining: 100 };
    expect(f.usage.burn("account", window, at + 1).observed).toBe(24);
    let notified = false;
    const unsubscribe = f.history.subscribeUsage(() => {
      notified = true;
    });
    const before = f.history.headSeq();
    f.history.deleteThread(deleted);
    expect(notified).toBe(true);
    unsubscribe();
    expect(f.history.headSeq()).toBeGreaterThan(before);
    f.reopen();
    await f.replay();
    expect(f.usage.summary(query).rows.map((row) => row.dimensions.thread)).toEqual(["kept"]);
    expect(f.usage.burn("account", window, at + 1).observed).toBe(12);
    f.rebuild();
    await f.replay();
    expect(f.usage.summary(query).rows.map((row) => row.dimensions.thread)).toEqual(["kept"]);
    expect(f.usage.burn("account", window, at + 1).observed).toBe(12);
    f.add("deleted");
    await f.replay();
    expect(f.usage.summary(query).rows.reduce((sum, row) => sum + row.totals.inputTokens, 0)).toBe(
      20,
    );
  } finally {
    f.close();
  }
});

it("incompatible retained usage advances coverage and reports omissions while healthy facts remain visible", async () => {
  const f = fixture();
  try {
    const id = f.add("retained", "");
    f.history.appendEvents(
      id,
      [
        EventPayload.parse({
          type: "usage.updated",
          agentId: "retained-agent",
          inputTokens: 20,
          outputTokens: 0,
        }),
      ],
      8.64e15 + 1,
    );
    f.add("healthy");
    await f.replay();
    const result = f.usage.summary(query);
    expect(result.cursor).toBe(f.history.headSeq());
    expect(result.omittedEvents).toBe(1);
    expect(result.rows.reduce((sum, row) => sum + row.totals.inputTokens, 0)).toBe(20);
  } finally {
    f.close();
  }
});

it("analytics subscription admission stays bounded and capacity returns after unsubscribe", () => {
  const f = fixture();
  const subscriptions = Array.from({ length: 16 }, () => f.history.subscribeUsage(() => {}));
  try {
    expect(() => f.history.subscribeUsage(() => {})).toThrow("capacity");
    subscriptions.pop()?.();
    let changed = false;
    subscriptions.push(
      f.history.subscribeUsage(() => {
        changed = true;
      }),
    );
    f.add("new");
    expect(changed).toBe(true);
  } finally {
    for (const unsubscribe of subscriptions) unsubscribe();
    f.close();
  }
});

it("canonical replay separates root and child activity from every inclusive snapshot across restart", async () => {
  const f = fixture();
  try {
    const id = f.add("scoped");
    const root = f.history.snapshotThread(id).agents["scoped-agent"];
    if (!root) throw new Error("Missing root");
    f.history.appendEvents(
      id,
      [
        EventPayload.parse({
          type: "agent.created",
          agent: { ...root, id: "child", parentId: root.id, origin: "provider_subagent" },
        }),
        EventPayload.parse({
          type: "usage.updated",
          agentId: "child",
          inputTokens: 4,
          outputTokens: 0,
        }),
        ...["sonnet", "opus"].map((model) =>
          EventPayload.parse({
            type: "usage.updated",
            agentId: root.id,
            inputTokens: 110,
            outputTokens: 20,
            usageScope: "model_session",
            counterKey: "native:initial",
            model,
            costUsd: 3.1,
          }),
        ),
        EventPayload.parse({
          type: "usage.updated",
          agentId: root.id,
          inputTokens: 220,
          outputTokens: 40,
          usageScope: "provider_session",
          counterKey: "native:initial",
          costUsd: 6.2,
        }),
      ],
      at,
    );
    await f.replay();
    expect(f.usage.summary(query).rows[0]?.totals).toMatchObject({
      inputTokens: 14,
      outputTokens: 2,
      providerReportedUsd: 0,
    });
    expect(f.usage.sessionTotalsFor({ thread: id })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "provider_session", inputTokens: 220, costUsd: 6.2 }),
        expect.objectContaining({ scope: "model_session", model: "sonnet", inputTokens: 110 }),
        expect.objectContaining({ scope: "model_session", model: "opus", inputTokens: 110 }),
      ]),
    );
    f.history.atomic((db) => {
      // Old clients materialized the final inclusive event over root activity.
      db.exec(
        "DELETE FROM status_migration WHERE id=2; DELETE FROM view_entities WHERE collection='usageSnapshots'",
      );
      db.prepare(
        "UPDATE view_entities SET value=(SELECT payload FROM events WHERE thread_id=? AND type='usage.updated' ORDER BY seq DESC LIMIT 1) WHERE collection='usage' AND thread_id=? AND id=?",
      ).run(id, id, root.id);
    });
    f.reopen();
    await f.replay();
    const restored = f.history.snapshotThread(id);
    expect(restored.usage[root.id]?.inputTokens).toBe(10);
    expect(Object.values(restored.usageSnapshots)).toHaveLength(3);
    expect(f.usage.sessionTotalsFor({ thread: id })).toHaveLength(3);
    expect(f.usage.summary(query).rows[0]?.totals.inputTokens).toBe(14);
  } finally {
    f.close();
  }
});

it("retained inclusive usage without a counter key is visibly omitted without blocking healthy replay", async () => {
  const f = fixture();
  try {
    const id = f.add("legacy");
    // Simulate a persisted record from the previous permissive schema, at the SQLite boundary.
    f.history.atomic((db) =>
      db
        .prepare(
          "UPDATE events SET payload=json_set(payload, '$.usageScope', 'provider_session') WHERE seq=?",
        )
        .run(f.history.headSeq()),
    );
    f.add("healthy");
    await f.replay();
    expect(f.usage.cursor()).toBe(f.history.headSeq());
    expect(f.usage.summary(query).omittedEvents).toBe(1);
    expect(f.usage.summary(query).rows[0]?.totals.inputTokens).toBe(10);
    expect(f.usage.sessionTotalsFor({ thread: id })).toEqual([]);
    expect(() =>
      EventPayload.parse({
        type: "usage.updated",
        agentId: "root",
        inputTokens: 1,
        outputTokens: 0,
        usageScope: "model_session",
      }),
    ).toThrow();
  } finally {
    f.close();
  }
});
