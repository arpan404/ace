import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Event } from "@ace/protocol";
import { UsageWorker, backfillBatch } from "./index.ts";
import { query } from "./test-support.ts";

it("backfill resumes across worker restarts and skipped transcript pages without losing or repeating usage", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-backfill-"));
  const path = join(home, "usage.sqlite");
  let worker = new UsageWorker(path);
  try {
    const events: Event[] = [];
    const add = (payload: unknown) =>
      events.push(
        Event.parse({
          seq: events.length + 1,
          id: `e${events.length}`,
          at: Date.parse("2026-10-02"),
          threadId: "t",
          payload,
        }),
      );
    add({
      type: "thread.created",
      thread: {
        id: "t",
        workspaceId: "w",
        provider: "codex",
        title: "private",
        status: { state: "new" },
        createdAt: 1,
        updatedAt: 1,
      },
    });
    add({
      type: "agent.created",
      agent: {
        id: "a",
        threadId: "t",
        parentId: null,
        model: "m".repeat(513),
        native: { provider: "codex", id: "native" },
        origin: "root",
        fidelity: "full",
        cwd: "/repo",
        status: { state: "idle" },
        createdAt: 1,
      },
    });
    for (let i = 0; i < 700; i++)
      add(
        i < 512
          ? { type: "item.delta", itemId: "i", agentId: "a", field: "text", append: "private" }
          : { type: "usage.updated", agentId: "a", inputTokens: i, outputTokens: 0 },
      );
    const history = {
      readUsagePage({ afterSeq, limit }: { afterSeq: number; limit: number }) {
        const page = events.slice(afterSeq, afterSeq + limit);
        return { events: page, throughSeq: page.at(-1)?.seq ?? afterSeq };
      },
    };
    expect(await backfillBatch(worker, history)).toBe(true);
    expect(await worker.cursor()).toBe(256);
    await worker.close();
    worker = new UsageWorker(path);
    while (await backfillBatch(worker, history)) {
      /* Each call commits one bounded page. */
    }
    expect(await worker.cursor()).toBe(702);
    expect((await worker.summary(query)).rows[0]?.totals.inputTokens).toBe(699);
    expect(await backfillBatch(worker, history)).toBe(false);
    add({ type: "usage.updated", agentId: "a", inputTokens: 705, outputTokens: 0 });
    await backfillBatch(worker, history);
    expect((await worker.summary(query)).rows[0]?.totals.inputTokens).toBe(705);
  } finally {
    await worker.close();
    rmSync(home, { recursive: true, force: true });
  }
});
it("worker backpressure rejects excess RPCs without abandoning accepted operations", async () => {
  const worker = new UsageWorker(":memory:");
  try {
    const accepted = Array.from({ length: 16 }, () => worker.cursor());
    await expect(worker.cursor()).rejects.toThrow("backpressure");
    expect(await Promise.all(accepted)).toEqual(Array(16).fill(0));
    await expect(worker.ingest({ afterSeq: 5, throughSeq: 5, events: [] })).rejects.toThrow(
      "rejected",
    );
    expect(await worker.cursor()).toBe(0);
  } finally {
    await worker.close();
  }
});

it("closing a saturated worker drains every accepted write before SQLite is reopened", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-drain-"));
  const path = join(home, "usage.sqlite");
  const worker = new UsageWorker(path);
  let reopened: UsageWorker | undefined;
  try {
    const accepted = Array.from({ length: 16 }, (_, i) =>
      worker.ingest({
        afterSeq: i,
        throughSeq: i + 1,
        events: [
          {
            seq: i + 1,
            at: Date.parse("2026-10-02"),
            threadId: "thread",
            payload:
              i === 0
                ? { type: "thread.created", workspace: "w", provider: "codex" }
                : i === 1
                  ? { type: "agent.created", id: "a", parent: null, model: null, provider: "codex" }
                  : { type: "usage.updated", agentId: "a", inputTokens: i, outputTokens: 0 },
          },
        ],
      }),
    );
    const closed = worker.close();
    await expect(worker.cursor()).rejects.toThrow("closing");
    expect(await Promise.all(accepted)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    await closed;
    reopened = new UsageWorker(path);
    expect(await reopened.cursor()).toBe(16);
    expect((await reopened.summary(query)).rows[0]?.totals.inputTokens).toBe(15);
  } finally {
    await worker.close();
    await reopened?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
