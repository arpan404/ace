import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventPayload, ThreadId, UsageQuery } from "@ace/protocol";
import { UsageSettings, type UsageEvent } from "@ace/usage";
import { afterEach, expect, test } from "vitest";
import { Store } from "./store.ts";
import { createDaemonUsage, usageFillingBacklog, type UsageHistory } from "./usage.ts";

// Process tier: the usage projection runs in its real worker thread on a real usage.sqlite.
// These are reads made while the replay hasn't projected everything committed yet.
const at = Date.parse("2026-10-02T12:00Z");
const query = UsageQuery.parse({ from: "2026-10-01", to: "2026-10-03", groupBy: ["thread"] });
const thread = ThreadId.parse("usage-reads");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const snapshot = (inputTokens: number) =>
  EventPayload.parse({
    type: "usage.updated",
    agentId: "root",
    inputTokens,
    outputTokens: 1,
    usageScope: "provider_session",
    counterKey: "session",
    model: "gpt-x",
  });
const total = (inputTokens: number) => ({
  counterKey: "session",
  scope: "provider_session",
  model: "gpt-x",
  at,
  inputTokens,
  outputTokens: 1,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  costUsd: 0,
});

/** A home with one thread and its first inclusive snapshot, and the usage service over it. */
async function open(history: (store: Store) => Partial<UsageHistory> = () => ({})) {
  const home = await mkdtemp(join(tmpdir(), "ace-usage-reads-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const store = new Store(join(home, "events.sqlite"), undefined, { now: () => at });
  cleanups.push(() => store.close());
  const workspace = store.createWorkspace("/repo", "Repo");
  store.appendEvents(
    thread,
    [
      EventPayload.parse({
        type: "thread.created",
        thread: {
          id: thread,
          workspaceId: workspace,
          provider: "codex",
          title: "Usage",
          status: { state: "new" },
          createdAt: at,
          updatedAt: at,
        },
      }),
      snapshot(100),
    ],
    at,
  );
  const usage = createDaemonUsage(
    home,
    {
      subscribeUsage: (listener) => store.subscribeUsage(listener),
      readUsagePage: (options) => store.readUsagePage(options),
      headSeq: () => store.headSeq(),
      flushLiveWrites: () => store.flushLiveWrites(),
      usageReplay: store.usageReplay,
      ...history(store),
    },
    UsageSettings.parse({ timezone: "UTC" }),
    () => {},
    undefined,
    () => at,
  );
  cleanups.push(() => usage.close());
  await usage.start();
  return { store, usage };
}

test("live usage the replay projects in time reads as complete, with no still-counting mark", async () => {
  const { store, usage } = await open();
  await usage.catchUp();
  store.appendEvents(thread, [snapshot(200)], at);
  const read = await usage.summary(query);
  expect(read.filling).toBeUndefined();
  expect(await usage.sessionTotals({ thread, limit: 100 })).toEqual([total(200)]);
});

test("a short backlog the replay doesn't reach in time keeps figures marked, and session totals still count it", async () => {
  let held = false;
  const { store, usage } = await open((events) => ({
    readUsagePage: (options) =>
      held ? { throughSeq: options.afterSeq, events: [] } : events.readUsagePage(options),
  }));
  await usage.catchUp();
  const counted = store.headSeq();
  held = true;
  store.appendEvents(thread, [snapshot(300), snapshot(250)], at);
  expect(store.headSeq() - counted).toBeLessThan(usageFillingBacklog);

  // Polling clients keep reading while anything committed is still unprojected.
  expect((await usage.summary(query)).filling).toEqual({ through: counted, head: store.headSeq() });
  // The thread's own events answer, so the newest snapshot is in the total.
  expect(await usage.sessionTotals({ thread, limit: 100 })).toEqual([total(300)]);

  held = false;
  await usage.catchUp();
  expect((await usage.summary(query)).filling).toBeUndefined();
  expect(await usage.sessionTotals({ thread, limit: 100 })).toEqual([total(300)]);
});

test("a replay page that keeps failing doesn't fail a thread's session totals", async () => {
  let failing = false;
  const { store, usage } = await open((events) => ({
    readUsagePage: (options) => {
      if (failing) throw new Error("database disk image is malformed");
      return events.readUsagePage(options);
    },
  }));
  await usage.catchUp();
  failing = true;
  store.appendEvents(thread, [snapshot(400)], at);
  expect(await usage.sessionTotals({ thread, limit: 100 })).toEqual([total(400)]);
});

test("folding a long thread's session totals never holds the event loop for long", async () => {
  // 200 slices of 256 inclusive snapshots each, far behind the replay: the direct fold reads
  // them all, and no single turn of the event loop may do much of that work.
  const slices = 200;
  const perSlice = 256;
  const { usage } = await open(() => ({
    headSeq: () => 1_000_000,
    usageReplay: {
      readSessionUsage(threadId, afterSeq) {
        if (afterSeq >= slices * perSlice) return { events: [], throughSeq: null };
        const events: UsageEvent[] = Array.from({ length: perSlice }, (_, index) => ({
          seq: afterSeq + index + 1,
          at,
          threadId,
          payload: {
            type: "usage.updated",
            agentId: "root",
            inputTokens: afterSeq + index + 1,
            outputTokens: 1,
            usageScope: "provider_session",
            counterKey: "session",
            model: "gpt-x",
          },
        }));
        return { events, throughSeq: afterSeq + perSlice };
      },
    },
  }));
  let longest = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 1);
  try {
    expect(await usage.sessionTotals({ thread, limit: 100 })).toEqual([total(slices * perSlice)]);
  } finally {
    // One more tick, so a block just before the answer is measured too.
    await new Promise((resolve) => setTimeout(resolve, 5));
    clearInterval(probe);
  }
  expect(longest).toBeLessThan(80);
});
