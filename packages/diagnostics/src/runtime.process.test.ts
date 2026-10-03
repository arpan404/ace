const noop = () => {};
import { Worker } from "node:worker_threads";
import { createServer } from "node:net";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { expect, it } from "vitest";
import {
  createFileSink,
  createHealthMonitor,
  checkIntegrity,
  recentThreadEvents,
} from "./index.ts";
import { temporary, deferred, controlledProbe } from "./test-support.ts";
import { controlledWorker } from "./test-support.ts";
it("an injected worker deadline terminates a real stalled log worker", async () => {
  let deadline = noop;
  let stopped: Promise<unknown> = Promise.resolve();
  const sink = createFileSink(
    { directory: await temporary(), fileBytes: 4096, totalBytes: 8192, context: {} },
    {
      spawn() {
        const worker = new Worker("setInterval(() => {}, 1000)", { eval: true });
        stopped = once(worker, "exit");
        return worker;
      },
      schedule(callback) {
        deadline = callback;
        return () => {};
      },
      deadlineMs: 123,
    },
  );
  const rejected = expect(sink).rejects.toThrow("Log worker timed out");
  deadline();
  await rejected;
  await stopped;
});
it("health reports native open resources and honors injected memory and workload measurements", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const monitor = createHealthMonitor(
    {
      database: join(await temporary(), "missing"),
      now: () => 0,
      workload: () => ({ activeSessions: 4, queues: { pending: 6 } }),
      logs: () => ({ dropped: 0, failed: 0, queued: 0 }),
    },
    {
      createDelay: () => ({
        count: 0,
        mean: 0,
        max: 0,
        percentile: () => 0,
        enable() {},
        disable() {},
        reset() {},
      }),
      memory: () => ({ rss: 123, heapUsed: 45, heapTotal: 67 }),
      resources: process.getActiveResourcesInfo,
      sqlite: async () => ({ pageBytes: null, walBytes: 0 }),
      schedule: () => () => {},
      deadlineMs: 123,
    },
  );
  try {
    const sample = await monitor.collect();
    expect(sample.openHandles).toBeGreaterThan(0);
    expect(sample.memory).toEqual({ rssBytes: 123, heapUsedBytes: 45, heapTotalBytes: 67 });
    expect(sample.activeSessions).toBe(4);
    expect(sample.queues).toEqual({ pending: 6 });
  } finally {
    monitor.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("cancellation stops a SQLite child after it has entered native work and preserves the database", async () => {
  const path = join(await temporary(), "events.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE example(value TEXT)");
  db.close();
  const before = await readFile(path);
  const entered = deferred<void>(),
    controller = new AbortController();
  let exited: Promise<unknown> = Promise.resolve();
  const checking = checkIntegrity(path, controller.signal, {
    deadlineMs: 5000,
    probe: async (_command, _args, options) =>
      controlledProbe(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(${JSON.stringify(path)}, { readOnly: true }); db.function("notify", () => { process.stdout.write("native-started\\n"); return 0; }); db.prepare("WITH RECURSIVE n(x) AS (SELECT notify() UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n").get();`,
        ],
        {
          ...options,
          spawn: (init) => {
            const process = spawnRawSupervised(init);
            exited = process.exited;
            process.stdout.on("data", (bytes: Buffer) => {
              if (bytes.toString().includes("native-started")) entered.resolve();
            });
            return process;
          },
        },
      ),
  });
  await Promise.race([
    entered.promise,
    checking.then(() => {
      throw new Error("SQLite exited before entering native work");
    }),
  ]);
  const rejected = expect(checking).rejects.toThrow("aborted");
  controller.abort();
  await rejected;
  expect(await exited).toMatchObject({ reason: "stopped" });
  expect(await readFile(path)).toEqual(before);
});
it("oversized event type columns are omitted before thread transfer", async () => {
  const path = join(await temporary(), "events.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE events(seq INTEGER PRIMARY KEY, at INTEGER, type TEXT, payload TEXT)");
  db.prepare("INSERT INTO events VALUES(1,0,?,'{}')").run("é".repeat(100000));
  db.close();
  const lines: string[] = [];
  for await (const line of recentThreadEvents(path, controlledWorker)) lines.push(line);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("OVERSIZED TYPE OMITTED");
  expect(Buffer.byteLength(lines[0] ?? "")).toBeLessThan(200);
});
it("advancing the health deadline aborts an in-flight measurement and returns unavailable sizes", async () => {
  const entered = deferred<void>();
  let deadline = noop;
  const monitor = createHealthMonitor(
    {
      database: "injected",
      now: () => 0,
      workload: () => ({ activeSessions: null, queues: {} }),
      logs: () => ({ dropped: 0, failed: 0, queued: 0 }),
    },
    {
      createDelay: () => ({
        count: 0,
        mean: 0,
        max: 0,
        percentile: () => 0,
        enable() {},
        disable() {},
        reset() {},
      }),
      memory: () => ({ rss: 1, heapUsed: 1, heapTotal: 1 }),
      resources: () => [],
      sqlite: async (_path, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ pageBytes: null, walBytes: null }), {
            once: true,
          });
          entered.resolve();
        }),
      schedule(callback) {
        deadline = callback;
        return noop;
      },
      deadlineMs: 123,
    },
  );
  try {
    const pending = monitor.collect();
    await entered.promise;
    deadline();
    const sample = await pending;
    expect(sample.sqlite).toEqual({ pageBytes: null, walBytes: null });
    expect(sample.openHandles).toBe(0);
  } finally {
    monitor.close();
  }
});
