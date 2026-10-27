import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { StorageSchedule } from "./schedule.ts";
import { SpaceReclaim } from "./space-reclaim.ts";
import { spaceReclaimTiming, type SpaceReclaimTiming } from "./space-reclaim-policy.ts";
import { storageFixture } from "./test-support.ts";

// Each test writes and compacts several megabytes of real SQLite.
vi.setConfig({ testTimeout: 30_000 });
type Fixture = Awaited<ReturnType<typeof storageFixture>>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const timing: SpaceReclaimTiming = { ...spaceReclaimTiming, recheckMs: 24 * 3600_000 };

/** Timers the test fires by hand; firing one advances the fixture clock by its delay. */
function manualTimers(advance: (ms: number) => void) {
  const queue: { delay: number; work: () => void }[] = [];
  const schedule: StorageSchedule = (delay, work) => {
    const timer = { delay, work };
    queue.push(timer);
    return () => {
      const index = queue.indexOf(timer);
      if (index >= 0) queue.splice(index, 1);
    };
  };
  /** Wait for the loop to arm its next timer. */
  async function armed(): Promise<number[]> {
    for (let turn = 0; !queue.length; turn++) {
      if (turn > 10_000) throw new Error("No timer was armed");
      await setImmediate();
    }
    return queue.map((timer) => timer.delay);
  }
  /** Wait for the next timer, then fire it. Returns the delay it waited. */
  async function fire(): Promise<number> {
    await armed();
    const timer = queue.shift();
    if (!timer) throw new Error("No timer was armed");
    advance(timer.delay);
    timer.work();
    return timer.delay;
  }
  /** Fire timers until the loop waits a full interval, which it does once nothing is left. */
  async function settle(): Promise<void> {
    for (let fired = 0; fired < 1000; fired++) if ((await fire()) === timing.intervalMs) return;
    throw new Error("Space reclaim never settled");
  }
  return { schedule, fire, settle, armed, pending: () => queue.map((timer) => timer.delay) };
}

async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-reclaim-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** About 8 MiB of rows, then half deleted: the deleted half becomes free pages. */
function fillAndDelete(f: Fixture) {
  f.store.atomic((db) => {
    db.exec("CREATE TABLE probe(id INTEGER PRIMARY KEY, body BLOB NOT NULL)");
    const insert = db.prepare("INSERT INTO probe(body) VALUES (?)");
    for (let i = 0; i < 2000; i++) insert.run(Buffer.alloc(4000, i % 251));
  });
  f.store.atomic((db) => db.exec("DELETE FROM probe WHERE id % 2 = 0"));
}

const freeBytes = (f: Fixture) =>
  Number(f.store.statement("PRAGMA freelist_count").get()?.freelist_count) *
  Number(f.store.statement("PRAGMA page_size").get()?.page_size);
const fileBytes = async (f: Fixture) => (await stat(join(f.root, "events.sqlite"))).size;

async function start(f: Fixture, schedule: StorageSchedule, overrides = {}) {
  const loop = new SpaceReclaim(
    { root: f.root, now: f.now, id: () => "reclaim", store: f.store, services: f.services },
    f.storage,
    schedule,
    { ...timing, ...overrides },
    (error) => {
      throw error;
    },
  );
  await loop.start();
  return loop;
}

test("free pages left by deleted rows are returned to the OS automatically without a setting", async () => {
  const f = await storageFixture();
  cleanups.push(() => f.close());
  const timers = manualTimers(f.advance);
  // No settings service at all: the loop needs none.
  expect(f.services.settings).toBeUndefined();
  fillAndDelete(f);
  const before = { free: freeBytes(f), file: await fileBytes(f) };
  expect(before.free).toBeGreaterThan(3 * 1024 * 1024);
  const loop = await start(f, timers.schedule);
  cleanups.push(() => loop.close());

  // Nothing happens during the startup delay.
  expect(await timers.armed()).toEqual([timing.startupMs]);
  // Only the loop's own schedule row may reuse a free page.
  expect(freeBytes(f)).toBeGreaterThan(before.free - 64 * 1024);

  await timers.settle();
  expect(freeBytes(f)).toBe(0);
  expect(await fileBytes(f)).toBeLessThan(before.file - 3 * 1024 * 1024);
  // The run ends with a truncating checkpoint; only the next due time's row is written after.
  expect((await stat(join(f.root, "events.sqlite-wal"))).size).toBeLessThan(16 * 1024);
});

test("automatic compaction never deletes rows, threads or rowids", async () => {
  const f = await storageFixture();
  cleanups.push(() => f.close());
  const timers = manualTimers(f.advance);
  // Archived and idle long ago: retention would remove these, reclaim must not.
  const threads = Array.from({ length: 5 }, (_, i) => f.thread(`expired-${i}`));
  fillAndDelete(f);
  const rows = () =>
    f.store
      .statement("SELECT id, hex(body) AS body FROM probe ORDER BY id")
      .all()
      .map((row) => `${String(row.id)}:${String(row.body)}`);
  const kept = rows();
  expect(kept).toHaveLength(1000);
  const loop = await start(f, timers.schedule, { chunksPerRun: 2 });
  cleanups.push(() => loop.close());

  await timers.settle();
  expect(freeBytes(f)).toBe(0);
  expect(rows()).toEqual(kept);
  for (const thread of threads) expect(f.store.getThread(thread.id)?.deletedAt).toBeUndefined();
});

test("a compaction cut short resumes after restart", async () => {
  const root = await directory();
  let f: Fixture = await storageFixture(root, undefined, { limits: { chunkPages: 64 } });
  const timers = manualTimers((ms) => f.advance(ms));
  fillAndDelete(f);
  const before = freeBytes(f);
  const first = await start(f, timers.schedule, { chunksPerRun: 1 });
  await timers.fire(); // startup delay; the probe window opens
  await timers.fire(); // probe closes quiet: one bounded run
  // The daemon stops between bounded runs, before the next one is due.
  expect(await timers.armed()).toEqual([timing.continueMs]);
  await first.close();
  await f.close();

  f = await storageFixture(root, undefined, { limits: { chunkPages: 64 } });
  const restartedFixture = f;
  cleanups.push(() => restartedFixture.close());
  const journal = () =>
    restartedFixture.store
      .statement("SELECT id, state FROM storage_compactions")
      .all()
      .map((row) => ({ id: String(row.id), state: String(row.state) }));
  const interrupted = journal();
  expect(interrupted).toEqual([{ id: expect.any(String), state: "running" }]);
  const remaining = freeBytes(f);
  expect(remaining).toBeLessThan(before);
  expect(remaining).toBeGreaterThan(0);

  // The restarted loop waits out the startup delay, then finishes the same journaled run.
  const restarted = await start(f, timers.schedule, { chunksPerRun: 1000 });
  cleanups.push(() => restarted.close());
  expect(timers.pending()).toEqual([timing.startupMs]);
  await timers.settle();
  expect(freeBytes(f)).toBe(0);
  expect(journal()).toEqual([{ id: interrupted[0]?.id, state: "complete" }]);
});

test("reclaim waits while the daemon writes heavily, then runs once writes calm down", async () => {
  const f = await storageFixture();
  cleanups.push(() => f.close());
  const timers = manualTimers(f.advance);
  fillAndDelete(f);
  const before = freeBytes(f);
  const loop = await start(f, timers.schedule);
  cleanups.push(() => loop.close());
  await timers.fire(); // startup delay; the probe window opens
  f.store.atomic((db) => db.exec("CREATE TABLE burst(n INTEGER)"));
  for (let i = 0; i <= timing.busyTransactions; i++)
    f.store.atomic((db) => db.prepare("INSERT INTO burst VALUES (?)").run(i));
  await timers.fire(); // probe closes on a busy window
  await timers.fire().then((delay) => expect(delay).toBe(timing.busyMs));
  expect(freeBytes(f)).toBeGreaterThan(before - 64 * 1024);

  await timers.settle();
  expect(freeBytes(f)).toBe(0);
});

test("stopping the daemon mid-run waits for the current chunk only", async () => {
  let loop: SpaceReclaim | undefined;
  let stopping: Promise<void> | undefined;
  const f: Fixture = await storageFixture(undefined, undefined, {
    limits: { chunkPages: 8 },
    afterCompactionStep: async () => {
      if (stopping) return;
      // As daemon shutdown does: stop storage admission, then close the loop.
      f.storage.stop();
      stopping = loop?.close();
    },
  });
  cleanups.push(() => f.close());
  const timers = manualTimers(f.advance);
  fillAndDelete(f);
  loop = await start(f, timers.schedule, { chunksPerRun: 1000 });
  await timers.fire();
  await timers.fire();
  await expect.poll(() => stopping !== undefined).toBe(true);
  await stopping;
  const journal = f.store.statement("SELECT document FROM storage_compactions").get();
  expect(JSON.parse(String(journal?.document))).toMatchObject({ state: "running", chunks: 1 });
  expect(freeBytes(f)).toBeGreaterThan(0);
  expect(timers.pending()).toEqual([]);
});

test("reclaim steps aside while other maintenance holds the store, without reporting a failure", async () => {
  const f = await storageFixture(undefined, undefined, { limits: { chunkPages: 64 } });
  cleanups.push(() => f.close());
  const timers = manualTimers(f.advance);
  fillAndDelete(f);
  // `start` reports any failure by throwing, which fails the test.
  const loop = await start(f, timers.schedule, { chunksPerRun: 1 });
  cleanups.push(() => loop.close());
  await timers.fire(); // startup delay
  await timers.fire(); // one bounded run; more is left
  expect(await timers.armed()).toEqual([timing.continueMs]);
  const before = freeBytes(f);
  expect(before).toBeGreaterThan(0);
  const release = Promise.withResolvers<void>();
  const held = f.store.maintenance(() => release.promise);
  await timers.fire(); // continue
  await timers.fire(); // probe closes; the run finds the store held
  // The next due time is saved once the other maintenance lets writers in again.
  for (let turn = 0; turn < 100; turn++) await setImmediate();
  expect(freeBytes(f)).toBe(before);
  release.resolve();
  await held;
  expect(await timers.armed()).toEqual([timing.busyMs]);

  await timers.settle();
  expect(freeBytes(f)).toBe(0);
});
