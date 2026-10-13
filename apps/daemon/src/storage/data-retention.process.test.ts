import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { SettingsService } from "@ace/settings";
import { storageFixture, storageNow } from "./test-support.ts";
import { DataRetention } from "./data-retention.ts";

const day = 86400000;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function setup() {
  const fixture = await storageFixture();
  cleanups.push(() => fixture.close());
  return fixture;
}
const deleted = (f: Awaited<ReturnType<typeof setup>>, id: string) =>
  f.store.getThread(id as never)?.deletedAt !== undefined;

test("retention deletes idle threads past the window, archived or not, and keeps working, waiting, pinned and recently active ones", async () => {
  const f = await setup();
  const unarchived = f.thread("idle-unarchived", { state: "done" }, {});
  const archived = f.thread("idle-archived");
  const working = f.thread("working", { state: "working", agents: 1 }, {});
  const waiting = f.thread("waiting", { state: "needs_you", interactions: 1 }, {});
  const limited = f.thread("limited", { state: "limited" }, {});
  const pinned = f.thread("pinned", { state: "done" }, {});
  f.store.appendEvents(
    pinned.id,
    [{ type: "thread.client.updated", changes: { pinned: true } }],
    1,
  );
  // Created long ago, but it ran ten days ago: last activity decides, not creation time.
  const active = f.thread("recently-active", { state: "done" }, {});
  f.store.appendEvents(
    active.id,
    [{ type: "thread.client.updated", changes: { activityAt: storageNow - 10 * day } }],
    1,
  );
  const result = await f.storage.retain(120, () => true);
  expect(result).toEqual({ removed: 2, complete: true });
  expect(deleted(f, unarchived.id)).toBe(true);
  expect(deleted(f, archived.id)).toBe(true);
  expect(f.store.readEvents({ afterSeq: 0, threadId: unarchived.id, limit: 10 })).toHaveLength(0);
  for (const kept of [working, waiting, limited, pinned, active]) {
    expect(deleted(f, kept.id)).toBe(false);
    expect(
      f.store.readEvents({ afterSeq: 0, threadId: kept.id, limit: 10 }).length,
    ).toBeGreaterThan(0);
  }
  // A second pass finds nothing and journals nothing.
  expect(await f.storage.retain(120, () => true)).toEqual({ removed: 0, complete: true });
});

test("rotated logs leave with their window while the live log stays", async () => {
  const f = await setup();
  const rotated = await f.file("logs/ace.1.jsonl", "rotated");
  await f.file("logs/ace.jsonl", "current");
  const result = await f.storage.retain(30, () => true);
  expect(result.removed).toBe(1);
  await expect(access(rotated)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.root, "logs/ace.jsonl"), "utf8")).toBe("current");
});

test("shortening the saved window runs a pass soon after, without a restart", async () => {
  const f = await setup();
  const dataDir = await mkdtemp(join(tmpdir(), "ace-retention-settings-"));
  const settings = new SettingsService({ dataDir, debounceMs: 0 });
  cleanups.push(async () => {
    await settings.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  f.services.settings = settings;
  const timers: { delay: number; work: () => void }[] = [];
  const retention = new DataRetention(
    { root: f.root, store: f.store, services: f.services, now: f.now, id: () => "unused" },
    f.storage,
    (delay, work) => {
      const timer = { delay, work };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
    { startupMs: 30_000, intervalMs: 6 * 3600_000, changeMs: 2_000, retryMs: 60_000 },
  );
  cleanups.push(() => retention.close());
  // Idle for 100 days: inside the default 120-day window, outside a 90-day one.
  const thread = f.thread("hundred-days", { state: "done" }, {});
  f.store.appendEvents(
    thread.id,
    [{ type: "thread.client.updated", changes: { activityAt: storageNow - 100 * day } }],
    1,
  );
  await retention.start();
  expect(retention.window()).toBe(120);
  expect(timers.map((timer) => timer.delay)).toEqual([30_000]);
  const run = async () => {
    timers.shift()?.work();
    // A finished pass always arms the next one.
    await expect.poll(() => timers.length).toBe(1);
  };
  await run();
  expect(deleted(f, thread.id)).toBe(false);
  expect(timers.map((timer) => timer.delay)).toEqual([6 * 3600_000]);

  await settings.set("storage.retentionDays", 90, { kind: "global" });
  await settings.settled({ kind: "global" });
  await expect.poll(() => retention.window()).toBe(90);
  expect(timers.map((timer) => timer.delay)).toEqual([2_000]);
  await run();
  expect(deleted(f, thread.id)).toBe(true);
});
