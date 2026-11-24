import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventPayload, ThreadId, UsageQuery } from "@ace/protocol";
import { UsageSettings } from "@ace/usage";
import { expect, test } from "vitest";
import { Store } from "./store.ts";
import { createDaemonUsage } from "./usage.ts";

const at = Date.parse("2026-10-02T12:00Z");
const query = UsageQuery.parse({ from: "2026-10-01", to: "2026-10-03", groupBy: ["thread"] });

test("analytics replay backs off, records its cause, and waits for new data once it gives up", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-usage-backoff-"));
  const store = new Store(join(home, "events.sqlite"), undefined, { now: () => at });
  let failing = true;
  let wake: (() => void) | undefined;
  const timers: { ms: number; fire(): void }[] = [];
  const failures: { message: string; attempt?: number; retryInMs?: number | null }[] = [];
  const usage = createDaemonUsage(
    home,
    {
      subscribeUsage(listener) {
        wake = listener;
        return store.subscribeUsage(listener);
      },
      readUsagePage(options) {
        if (failing) throw new Error("database disk image is malformed");
        return store.readUsagePage(options);
      },
      headSeq: () => store.headSeq(),
      flushLiveWrites: () => store.flushLiveWrites(),
      usageReplay: store.usageReplay,
    },
    UsageSettings.parse({ timezone: "UTC" }),
    (error, failure) =>
      failures.push({
        message: error instanceof Error ? error.message : String(error),
        ...failure,
      }),
    undefined,
    () => at,
    undefined,
    undefined,
    {
      delay(fire, ms) {
        const timer = { ms, fire };
        timers.push(timer);
        return () => {
          const index = timers.indexOf(timer);
          if (index >= 0) timers.splice(index, 1);
        };
      },
    },
  );
  const settled = async () => {
    for (let i = 0; i < 20 && timers.length === 0; i++)
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
  };
  const fireNext = async () => {
    const timer = timers.shift();
    if (!timer) throw new Error("No retry armed");
    const before = failures.length;
    timer.fire();
    for (let i = 0; i < 200 && failures.length === before; i++)
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    return timer.ms;
  };
  try {
    await usage.start();
    await settled();
    // A deterministic failure: each step doubles up to the cap, then replay stops on its bound.
    const waits: number[] = [];
    while (timers.length > 0) waits.push(await fireNext());
    expect(waits).toEqual([
      // The first wake is the coalescing timer; each wait after it is one backoff step.
      100, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000, 300000,
    ]);
    expect(failures).toHaveLength(13);
    expect(failures.every((entry) => entry.message === "database disk image is malformed")).toBe(
      true,
    );
    expect(failures.at(-1)).toMatchObject({ attempt: 13, retryInMs: null });
    expect(timers).toEqual([]);
    // New usage data earns one capped retry, however often it arrives.
    wake?.();
    wake?.();
    expect(timers.map((timer) => timer.ms)).toEqual([300000]);
    failing = false;
    const retry = timers.shift();
    retry?.fire();
    await usage.catchUp();
    expect(failures).toHaveLength(13);
    expect(timers).toEqual([]);
    expect((await usage.series(query)).cursor).toBe(store.headSeq());
  } finally {
    await usage.close().catch(() => {});
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a burst of commits waking usage causes one replay, which reads the last commit", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-usage-burst-"));
  const store = new Store(join(home, "events.sqlite"), undefined, { now: () => at });
  const workspace = store.createWorkspace("/repo", "Repo");
  const threadId = ThreadId.parse("usage-burst");
  store.appendEvents(
    threadId,
    [
      EventPayload.parse({
        type: "thread.created",
        thread: {
          id: threadId,
          workspaceId: workspace,
          provider: "opencode",
          title: "Usage",
          status: { state: "new" },
          createdAt: at,
          updatedAt: at,
        },
      }),
      EventPayload.parse({
        type: "agent.created",
        agent: {
          id: "root",
          threadId,
          parentId: null,
          native: { provider: "opencode", id: "native" },
          origin: "root",
          fidelity: "full",
          cwd: "/repo",
          status: { state: "idle" },
          createdAt: at,
        },
      }),
    ],
    at,
  );
  const sample = (inputTokens: number) =>
    store.appendEvents(
      threadId,
      [
        EventPayload.parse({
          type: "usage.updated",
          agentId: "root",
          inputTokens,
          outputTokens: 0,
        }),
      ],
      at,
    );
  // Reads count replay laps: a lap reads the page, and its flush can commit, so a lap that a
  // commit wakes must not become the next lap.
  let reads = 0;
  const timers: { ms: number; fire(): void }[] = [];
  const usage = createDaemonUsage(
    home,
    {
      subscribeUsage: (listener) => store.subscribeUsage(listener),
      readUsagePage(options) {
        reads++;
        return store.readUsagePage(options);
      },
      headSeq: () => store.headSeq(),
      flushLiveWrites: () => store.flushLiveWrites(),
      usageReplay: store.usageReplay,
    },
    UsageSettings.parse({ timezone: "UTC" }),
    () => {},
    undefined,
    () => at,
    undefined,
    undefined,
    {
      delay(fire, ms) {
        const timer = { ms, fire };
        timers.push(timer);
        return () => {
          const index = timers.indexOf(timer);
          if (index >= 0) timers.splice(index, 1);
        };
      },
    },
  );
  try {
    await usage.catchUp();
    const readsBeforeBurst = reads;
    for (const inputTokens of [1, 2, 3, 4]) {
      sample(inputTokens);
      // Each commit lands in its own turn, as a streamed answer's commits do.
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      expect(reads).toBe(readsBeforeBurst);
      expect(timers).toHaveLength(1);
    }
    const burst = timers.shift();
    if (!burst) throw new Error("The burst scheduled no replay");
    burst.fire();
    await usage.catchUp();
    expect(reads).toBeGreaterThan(readsBeforeBurst);
    // The one replay after the burst sees every commit, including the last: incremental counts
    // from opencode add up, so 10 requires all four events and not just the first.
    expect((await usage.series(query)).cursor).toBe(store.headSeq());
    expect((await usage.series(query)).rows[0]?.totals.inputTokens).toBe(10);
    // Stopping the daemon cancels the wake it armed, so no replay starts after close.
    sample(5);
    expect(timers).toHaveLength(1);
    await usage.close();
    expect(timers).toEqual([]);
  } finally {
    await usage.close().catch(() => {});
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
