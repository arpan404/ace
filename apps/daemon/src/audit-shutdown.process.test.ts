/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker boundary. */
import { expect, test } from "vitest";
import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { watch, existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startDaemon, readConfig } from "./index.ts";
import { Resources } from "./services/resources.ts";
import { runDaemonProcess } from "./process-daemon.ts";
import { daemonLogRecords } from "./daemon-log-test-support.ts";
import { retainNotifications } from "./notification-test-support.ts";

async function stalledWorker() {
  const root = await mkdtemp(join(tmpdir(), "ace-shutdown-audit-"));
  // A saved push device needs the worker from startup, so there is a worker whose close stalls.
  await retainNotifications(root);
  const held = Promise.withResolvers<void>();
  const cleanupDeadline = Promise.withResolvers<() => void>();
  const overallDeadline = Promise.withResolvers<() => void>();
  let release: (() => void) | undefined;
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: root, ACE_PORT: "0", ACE_LOG_LEVEL: "error" }),
    modelInstances: [],
    history: { instances: [] },
    notificationWorker(entry, options) {
      const worker = new Worker(entry, options),
        post = worker.postMessage.bind(worker);
      worker.postMessage = (message: unknown) => {
        const call = z
          .object({ type: z.literal("call"), call: z.object({ method: z.string() }) })
          .safeParse(message);
        if (call.success && call.data.call.method === "close") {
          release = () => post(message);
          held.resolve();
        } else post(message);
      };
      return worker;
    },
    startup: {
      schedule(name, expire, milliseconds) {
        if (name === "notifications" && milliseconds === 6000) {
          cleanupDeadline.resolve(expire);
          return () => {};
        }
        if (name === "shutdown") {
          overallDeadline.resolve(expire);
          return () => {};
        }
        const timer = setTimeout(expire, milliseconds);
        return () => clearTimeout(timer);
      },
    },
  });
  return {
    root,
    daemon,
    held: held.promise,
    cleanupDeadline: cleanupDeadline.promise,
    overallDeadline: overallDeadline.promise,
    resume() {
      release?.();
    },
    async settle() {
      const unlocked = Promise.withResolvers<void>();
      const path = join(root, "daemon-lock");
      const watcher = watch(root, () => {
        if (!existsSync(path)) unlocked.resolve();
      });
      if (!existsSync(path)) unlocked.resolve();
      try {
        release?.();
        await daemon.notifications.close();
        await unlocked.promise;
      } finally {
        watcher.close();
      }
    },
    async release() {
      await this.settle();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** How `close` settled, as a value: a failed shutdown never leaves an assertion pending. */
function outcome(closing: Promise<void>): Promise<unknown> {
  return closing.then(
    () => new Error("close resolved instead of failing"),
    (error: unknown) => error,
  );
}

test("a failed cleanup names its service and still removes the endpoint", async () => {
  const f = await stalledWorker();
  try {
    const failed = outcome(f.daemon.close());
    await f.held;
    (await f.cleanupDeadline)();
    f.resume();
    expect(await failed).toMatchObject({
      message: expect.stringContaining("Daemon shutdown failed"),
    });
    await expect(readFile(join(f.root, "daemon-endpoint"))).rejects.toThrow("ENOENT");
    const log = await readFile(join(f.root, "logs/daemon.log"), "utf8").catch(async () => {
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(join(f.root, "logs"));
      return (
        await Promise.all(files.map((file) => readFile(join(f.root, "logs", file), "utf8")))
      ).join("\n");
    });
    expect(log).toContain('"service":"notifications"');
    expect(log).toContain("Service cleanup failed");
  } finally {
    await f.release();
  }
});

test("the overall deadline removes discovery but retains the home lock until stalled cleanup settles", async () => {
  const f = await stalledWorker();
  try {
    const failed = outcome(f.daemon.close());
    await f.held;
    (await f.overallDeadline)();
    expect(await failed).toMatchObject({
      message: expect.stringContaining("Daemon shutdown deadline exceeded"),
    });
    await expect(readFile(join(f.root, "daemon-endpoint"))).rejects.toThrow("ENOENT");
    const { acquireLock } = await import("./local-files.ts");
    expect(() => acquireLock(f.root)).toThrow("Another daemon owns it");
    await f.settle();
    const unlock = acquireLock(f.root);
    unlock();
  } finally {
    await f.release();
  }
});

test("when a resource hangs, the deadline log names it and the next start reports the overrun, not a crash", async () => {
  const f = await stalledWorker();
  try {
    const failed = outcome(f.daemon.close());
    await f.held;
    (await f.overallDeadline)();
    expect(await failed).toMatchObject({
      message: expect.stringContaining("Daemon shutdown deadline exceeded"),
    });
    const overran = (await daemonLogRecords(f.root)).find(
      (record) => record.message === "Daemon shutdown deadline exceeded",
    );
    expect(overran?.data?.pending).toEqual(
      expect.arrayContaining([expect.stringContaining("service notifications")]),
    );
    await f.settle();
    const next = await startDaemon({
      config: readConfig({ ACE_HOME: f.root, ACE_PORT: "0", ACE_LOG_LEVEL: "info" }),
      modelInstances: [],
      history: { instances: [] },
    });
    await next.close();
    const messages = (await daemonLogRecords(f.root)).map((record) => record.message);
    expect(messages).toContain(
      "Previous daemon run stopped after its shutdown deadline; some resources had not closed",
    );
    expect(messages).not.toContain(
      "Previous daemon run ended without stopping: it crashed or was killed",
    );
  } finally {
    await f.release();
  }
});

test("independent cleanups start together and shared dependencies close after both settle", async () => {
  const resources = new Resources();
  const release = Promise.withResolvers<void>(),
    started = Promise.withResolvers<void>();
  const finished: string[] = [];
  let count = 0;
  resources.own(() => {
    finished.push("database");
  });
  for (const name of ["alpha", "beta"])
    resources.ownParallel(async () => {
      if (++count === 2) started.resolve();
      await release.promise;
      finished.push(name);
    });
  const closing = resources.close();
  await started.promise;
  expect(finished).toEqual([]);
  release.resolve();
  await closing;
  expect(finished).toEqual(["alpha", "beta", "database"]);
});

// A startup cancellation may leave a native handle alive after the startup promise rejects.
test("process shutdown keeps its exit deadline armed after cancelled startup", async () => {
  const signals = new EventEmitter();
  const started = Promise.withResolvers<void>();
  const deadline = Promise.withResolvers<() => void>();
  const exits: number[] = [];
  const starting = runDaemonProcess(
    async (options) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        options.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw new Error("Startup aborted");
    },
    {},
    signals,
    {
      after(expire) {
        deadline.resolve(expire);
        return () => {
          throw new Error("Exit deadline cancelled");
        };
      },
      exit(code) {
        exits.push(code);
      },
    },
  );
  await started.promise;
  signals.emit("SIGTERM");
  expect(await starting).toBeUndefined();
  (await deadline.promise)();
  expect(exits).toEqual([1]);
});
