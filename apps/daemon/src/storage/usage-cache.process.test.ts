import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { StorageUsage } from "@ace/protocol";
import { Store } from "../store.ts";
import { UsageCache, USAGE_INTERVAL, USAGE_PARTIAL_RETRY } from "./usage-cache.ts";
import { UsageCoordinator, type Activity } from "./usage-schedule.ts";

const homes: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const usage = (bytes: number, complete = true) =>
  StorageUsage.parse({
    categories: [{ kind: "threads", bytes, items: 1 }],
    databaseBytes: 100,
    reclaimableDatabaseBytes: 0,
    measuredAt: bytes,
    complete,
  });
function deferred<T>() {
  return Promise.withResolvers<T>();
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ace-usage-cache-"));
  homes.push(root);
  const path = join(root, "events.sqlite");
  const store = new Store(path);
  closers.push(async () => {
    await store.close();
  });
  let now = 1000;
  let activity: Activity = { cpu: 0.1, disk: 0 };
  const timers = new Set<{ at: number; work(): void }>();
  const scans: ReturnType<typeof deferred<StorageUsage>>[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  let started = deferred<void>();
  const cache = new UsageCache(store, root, "host-a");
  const runtime = {
    now: () => now,
    schedule: (delay: number, work: () => void) => {
      const timer = { at: now + delay, work };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
    activity: async () => activity,
    failed: () => {},
  };
  let idle: Promise<void> = Promise.resolve();
  const scanner = {
    waitForIdle: () => idle,
    scan: (signal?: AbortSignal) => {
      const flight = deferred<StorageUsage>();
      scans.push(flight);
      signals.push(signal);
      started.resolve();
      idle = flight.promise.then(
        () => {},
        () => {},
      );
      return flight.promise;
    },
    close: async () => {
      for (const scan of scans) scan.reject(new Error("closed"));
    },
  };
  const coordinator = new UsageCoordinator(cache, scanner, runtime);
  closers.push(() => coordinator.close());
  return {
    root,
    store,
    cache,
    coordinator,
    runtime,
    scanner,
    scans,
    signals,
    timers,
    time: (value: number) => {
      now = value;
    },
    activity: (value: Activity) => {
      activity = value;
    },
    started: async () => {
      await started.promise;
      started = deferred<void>();
    },
    tick: async () => {
      const due = [...timers].filter((timer) => timer.at <= now);
      for (const timer of due) {
        timers.delete(timer);
        timer.work();
      }
      // Drain the timer's async activity and scan continuation, without real-time sleeps.
      for (let index = 0; index < 10; index++) await Promise.resolve();
    },
  };
}

test("first reads and explicit refresh share one scan, while cached reads stay immediate", async () => {
  const f = await fixture();
  const first = f.coordinator.read(),
    other = f.coordinator.read(true);
  await f.started();
  expect(f.scans).toHaveLength(1);
  f.scans[0]?.resolve(usage(10, false));
  expect(await first).toEqual(usage(10, false));
  expect(await other).toEqual(usage(10, false));
  const forced = f.coordinator.read(true);
  await f.started();
  expect(await f.coordinator.read()).toEqual(usage(10, false));
  const joined = f.coordinator.read(true);
  expect(f.scans).toHaveLength(2);
  f.scans[1]?.resolve(usage(20));
  expect(await forced).toEqual(usage(20));
  expect(await joined).toEqual(usage(20));
});

test("a reopened SQLite snapshot keeps its completion deadline and partial flag", async () => {
  const f = await fixture();
  const first = f.coordinator.read();
  await f.started();
  f.time(9000);
  f.scans[0]?.resolve(usage(10, false));
  await first;
  await f.coordinator.close();
  const reopened = new Store(join(f.root, "events.sqlite"));
  closers.push(async () => {
    await reopened.close();
  });
  const durable = new UsageCache(reopened, f.root, "host-a");
  expect(durable.load(10000)).toEqual({ usage: usage(10, false), due: 9000 + USAGE_PARTIAL_RETRY });
  expect(new UsageCache(reopened, f.root, "host-b").load(10000)).toEqual({ due: 10000 });
  expect(new UsageCache(reopened, join(f.root, "other"), "host-a").load(10000)).toEqual({
    due: 10000,
  });
});

test("corrupt persisted measurements are ignored instead of served", async () => {
  const f = await fixture();
  f.cache.save(usage(10), 5000);
  f.store.statement("UPDATE storage_usage_cache SET document=?").run('{"databaseBytes":-1}');
  expect(f.cache.load(3000)).toEqual({ due: 3000 });
});

test("overdue startup defers busy or unknown activity without resetting four hours", async () => {
  const f = await fixture();
  f.cache.save(usage(10), 1000);
  const coordinator = new UsageCoordinator(f.cache, f.scanner, f.runtime);
  closers.push(() => coordinator.close());
  f.activity({ cpu: 0.01, disk: null });
  coordinator.start();
  f.time(1001);
  await f.tick();
  expect(f.scans).toHaveLength(0);
  expect(f.cache.load(1001).due).toBe(1000);
  expect([...f.timers].map((timer) => timer.at)).toContain(1001 + 15 * 60000);
  f.activity({ cpu: 0.8, disk: 0 });
  f.time(1001 + 15 * 60000);
  await f.tick();
  expect(f.scans).toHaveLength(0);
  f.activity({ cpu: 0.1, disk: 10 });
  f.time(1001 + 16 * 60000);
  await f.tick();
  expect(f.scans).toHaveLength(1);
  f.scans[0]?.resolve(usage(20));
  for (let index = 0; index < 10; index++) await Promise.resolve();
  expect(await coordinator.read()).toEqual(usage(20));
  expect(f.cache.load(0).due).toBe(1001 + 16 * 60000 + USAGE_INTERVAL);
});

test("refresh bypasses unknown disk activity and failed scans preserve the durable snapshot", async () => {
  const f = await fixture();
  const initial = f.coordinator.read();
  await f.started();
  f.scans[0]?.resolve(usage(10));
  await initial;
  f.coordinator.start();
  f.activity({ cpu: null, disk: null });
  const forced = f.coordinator.read(true);
  await f.started();
  const rejected = expect(forced).rejects.toThrow("broken");
  f.scans[1]?.reject(new Error("broken"));
  await rejected;
  expect(await f.coordinator.read()).toEqual(usage(10));
  expect(f.cache.load(0).usage).toEqual(usage(10));
  expect([...f.timers].map((timer) => timer.at)).toContain(1000 + 5 * 60000);
});

test("cleanup invalidates a running generation and refresh waits until mutations finish", async () => {
  const f = await fixture();
  const initial = f.coordinator.read();
  await f.started();
  f.scans[0]?.resolve(usage(10));
  await initial;
  const forced = f.coordinator.read(true);
  await f.started();
  const effects = deferred<void>();
  let effectStarted = false;
  const mutation = f.coordinator.mutation(() => {
    effectStarted = true;
    return effects.promise;
  });
  expect(f.signals[1]?.aborted).toBe(true);
  expect(effectStarted).toBe(false);
  f.scans[1]?.resolve(usage(999));
  for (let index = 0; index < 10; index++) await Promise.resolve();
  expect(f.scans).toHaveLength(2);
  expect(effectStarted).toBe(true);
  expect(await f.coordinator.read()).toEqual(usage(10));
  expect(f.cache.load(0).usage).toEqual(usage(10));
  effects.resolve();
  await mutation;
  await f.started();
  f.scans[2]?.resolve(usage(30));
  expect(await forced).toEqual(usage(30));
  expect(f.cache.load(0).usage).toEqual(usage(30));
});

test("shutdown aborts an active scan and cannot publish its late result", async () => {
  const f = await fixture();
  const initial = f.coordinator.read();
  await f.started();
  f.scans[0]?.resolve(usage(10));
  await initial;
  const forced = f.coordinator.read(true);
  await f.started();
  const rejected = expect(forced).rejects.toThrow();
  await f.coordinator.close();
  await rejected;
  expect(f.signals[1]?.aborted).toBe(true);
  f.scans[1]?.resolve(usage(999));
  expect(f.cache.load(0).usage).toEqual(usage(10));
});

test("future startup deadlines run no activity probes and refresh advances from completion", async () => {
  const f = await fixture();
  f.cache.save(usage(10), 1000 + USAGE_INTERVAL);
  let probed = false;
  const coordinator = new UsageCoordinator(f.cache, f.scanner, {
    ...f.runtime,
    activity: async () => {
      probed = true;
      return { cpu: 0, disk: 0 };
    },
  });
  closers.push(() => coordinator.close());
  coordinator.start();
  f.time(1000 + USAGE_INTERVAL - 1);
  await f.tick();
  expect(probed).toBe(false);
  expect(await coordinator.read()).toEqual(usage(10));
  f.time(1000 + USAGE_INTERVAL);
  await f.tick();
  expect(probed).toBe(true);
  const joined = coordinator.read(true);
  expect(f.scans).toHaveLength(1);
  f.time(2000 + USAGE_INTERVAL);
  f.scans[0]?.resolve(usage(20));
  await joined;
  expect(f.cache.load(0).due).toBe(2000 + 2 * USAGE_INTERVAL);
});

test("a refresh requested just before mutation admission cannot start during its effects", async () => {
  const f = await fixture();
  const read = f.coordinator.read(true);
  const effects = deferred<void>();
  const mutation = f.coordinator.mutation(() => effects.promise);
  for (let index = 0; index < 10; index++) await Promise.resolve();
  expect(f.scans).toHaveLength(0);
  effects.resolve();
  await mutation;
  await f.started();
  f.scans[0]?.resolve(usage(10));
  expect(await read).toEqual(usage(10));
});

test("an invalid worker result preserves the last valid snapshot", async () => {
  const f = await fixture();
  const initial = f.coordinator.read();
  await f.started();
  f.scans[0]?.resolve(usage(10));
  await initial;
  const forced = f.coordinator.read(true);
  await f.started();
  const rejected = expect(forced).rejects.toThrow();
  f.scans[1]?.resolve({ ...usage(20), databaseBytes: -1 });
  await rejected;
  expect(await f.coordinator.read()).toEqual(usage(10));
  expect(f.cache.load(0).usage).toEqual(usage(10));
});

test("a scan deadline cancels worker activity without replacing its previous snapshot", async () => {
  const f = await fixture();
  f.cache.save(usage(10), 1000);
  const scanner = {
    waitForIdle: async () => {},
    close: async () => {},
    scan: (signal?: AbortSignal) =>
      new Promise<StorageUsage>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
  };
  const coordinator = new UsageCoordinator(f.cache, scanner, f.runtime);
  closers.push(() => coordinator.close());
  const forced = coordinator.read(true);
  const rejected = expect(forced).rejects.toThrow("cancelled");
  for (let index = 0; index < 10; index++) await Promise.resolve();
  f.time(1000 + 10 * 60000);
  await f.tick();
  await rejected;
  expect(f.cache.load(0).usage).toEqual(usage(10));
});

test("shutdown has a bounded wait even when a scanner fails to close", async () => {
  const f = await fixture();
  f.cache.save(usage(10), 1000);
  const scanner = {
    waitForIdle: () => new Promise<void>(() => {}),
    close: () => new Promise<void>(() => {}),
    scan: async () => usage(20),
  };
  const coordinator = new UsageCoordinator(f.cache, scanner, f.runtime);
  const close = coordinator.close();
  const rejected = expect(close).rejects.toThrow("storage_usage_shutdown_timeout");
  f.time(6000);
  await f.tick();
  await rejected;
  expect(f.cache.load(0).usage).toEqual(usage(10));
});

test("a worker that cannot cancel prevents mutation effects instead of racing SQLite readers", async () => {
  const f = await fixture();
  const initial = f.coordinator.read();
  await f.started();
  f.scans[0]?.resolve(usage(10));
  await initial;
  const forced = f.coordinator.read(true);
  await f.started();
  let changed = false;
  const mutation = f.coordinator.mutation(async () => {
    changed = true;
  });
  const rejected = expect(mutation).rejects.toThrow("storage_scan_cancel_timeout");
  expect(changed).toBe(false);
  f.time(6000);
  await f.tick();
  await rejected;
  expect(changed).toBe(false);
  expect(f.cache.load(0).usage).toEqual(usage(10));
  // Once the old worker settles, the waiting refresh can start its replacement scan.
  f.scans[1]?.reject(new Error("cancelled"));
  await f.started();
  f.scans[2]?.resolve(usage(20));
  expect(await forced).toEqual(usage(20));
});

test("a persisted partial scan retries soon after restart and can become complete", async () => {
  const f = await fixture();
  const initial = f.coordinator.read();
  await f.started();
  f.scans[0]?.resolve(usage(10, false));
  await initial;
  expect(f.cache.load(0).due).toBe(1000 + USAGE_PARTIAL_RETRY);
  await f.coordinator.close();
  const restarted = new UsageCoordinator(
    new UsageCache(f.store, f.root, "host-a"),
    f.scanner,
    f.runtime,
  );
  closers.push(() => restarted.close());
  restarted.start();
  f.time(1000 + USAGE_PARTIAL_RETRY - 1);
  await f.tick();
  expect(f.scans).toHaveLength(1);
  f.time(1000 + USAGE_PARTIAL_RETRY);
  await f.tick();
  expect(f.scans).toHaveLength(2);
  const joined = restarted.read(true);
  f.scans[1]?.resolve(usage(20));
  await joined;
  expect(await restarted.read()).toEqual(usage(20));
  expect(f.cache.load(0).due).toBe(1000 + USAGE_PARTIAL_RETRY + USAGE_INTERVAL);
});

test("compaction waits for a cancelled scanner to release a real SQLite read transaction", async () => {
  const f = await fixture();
  f.store.statement("CREATE TABLE usage_reader_probe(value TEXT)").run();
  f.store.statement("INSERT INTO usage_reader_probe VALUES ('before')").run();
  f.cache.save(usage(10), 1000);
  const released = deferred<void>();
  const opened = deferred<void>();
  const cancelled = deferred<void>();
  let reader: DatabaseSync | undefined;
  const idle = deferred<void>();
  const scanner = {
    waitForIdle: () => idle.promise,
    scan: async (signal?: AbortSignal) => {
      reader = new DatabaseSync(join(f.root, "events.sqlite"), { readOnly: true });
      reader.exec("BEGIN");
      reader.prepare("SELECT * FROM usage_reader_probe").all();
      signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
      opened.resolve();
      await released.promise;
      reader.close();
      reader = undefined;
      idle.resolve();
      signal?.throwIfAborted();
      return usage(20);
    },
    close: async () => {
      released.resolve();
      reader?.close();
      reader = undefined;
      idle.resolve();
    },
  };
  const coordinator = new UsageCoordinator(f.cache, scanner, f.runtime);
  closers.push(() => coordinator.close());
  const forced = coordinator.read(true);
  await opened.promise;
  f.store.statement("INSERT INTO usage_reader_probe VALUES ('after')").run();
  let checkpointed = false;
  const mutation = coordinator.mutation(async () => {
    expect(f.store.statement("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy).toBe(0);
    checkpointed = true;
  });
  await cancelled.promise;
  expect(checkpointed).toBe(false);
  // Close the cancelled refresh before it can begin a replacement read transaction.
  coordinator.stop();
  const rejected = expect(forced).rejects.toThrow();
  released.resolve();
  await mutation;
  await rejected;
  expect(checkpointed).toBe(true);
});

test("cold startup waits for the first usage request before probes, scans or retries", async () => {
  const f = await fixture();
  let probed = false;
  f.runtime.activity = async () => {
    probed = true;
    return { cpu: 0, disk: 0 };
  };
  f.coordinator.start();
  f.time(24 * 60 * 60000);
  await f.tick();
  await f.coordinator.mutation(async () => {});
  await f.tick();
  expect(probed).toBe(false);
  expect(f.scans).toHaveLength(0);
  expect(f.timers.size).toBe(0);
  const first = f.coordinator.read();
  await f.started();
  const rejected = expect(first).rejects.toThrow("first attempt failed");
  f.scans[0]?.reject(new Error("first attempt failed"));
  await rejected;
  f.time(24 * 60 * 60000 + 5 * 60000);
  await f.tick();
  expect(probed).toBe(true);
  expect(f.scans).toHaveLength(2);
  const joined = f.coordinator.read(true);
  f.scans[1]?.resolve(usage(20));
  expect(await joined).toEqual(usage(20));
});

test.each([
  { outcome: "waits until actual exit", exits: true },
  { outcome: "refuses effects after the exit deadline", exits: false },
])("after caller rejection a mutation $outcome", async ({ exits }) => {
  const f = await fixture();
  f.cache.save(usage(10), 1000);
  f.store.statement("CREATE TABLE usage_exit_effect(value TEXT)").run();
  const caller = deferred<StorageUsage>();
  const entered = deferred<void>();
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const spawned = once(worker, "spawn");
  const exited = once(worker, "exit").then(() => {});
  const scanner = {
    scan: () => {
      entered.resolve();
      return caller.promise;
    },
    waitForIdle: () => exited,
    close: async () => {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
      await exited;
    },
  };
  const coordinator = new UsageCoordinator(f.cache, scanner, f.runtime);
  closers.push(() => coordinator.close());
  await spawned;
  const forced = coordinator.read(true);
  await entered.promise;
  const rejected = expect(forced).rejects.toThrow("worker reap timed out");
  caller.reject(new Error("worker reap timed out"));
  await rejected;
  // The caller has finished and refresh state was cleared, but the child is still running.
  const mutation = coordinator.mutation(async () => {
    f.store.statement("INSERT INTO usage_exit_effect VALUES ('changed')").run();
  });
  for (let index = 0; index < 10; index++) await Promise.resolve();
  expect(f.store.statement("SELECT COUNT(*) AS n FROM usage_exit_effect").get()?.n).toBe(0);
  expect(worker.exitCode).toBeNull();
  expect(worker.signalCode).toBeNull();
  if (exits) {
    worker.kill("SIGKILL");
    await mutation;
    expect(f.store.statement("SELECT COUNT(*) AS n FROM usage_exit_effect").get()?.n).toBe(1);
  } else {
    const refused = expect(mutation).rejects.toThrow("storage_scan_cancel_timeout");
    f.time(6000);
    await f.tick();
    await refused;
    expect(worker.exitCode).toBeNull();
    expect(worker.signalCode).toBeNull();
    worker.kill("SIGKILL");
    await exited;
    expect(f.store.statement("SELECT COUNT(*) AS n FROM usage_exit_effect").get()?.n).toBe(0);
  }
  expect(await coordinator.read()).toEqual(usage(10));
});
