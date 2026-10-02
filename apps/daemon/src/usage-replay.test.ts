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
