import { DatabaseSync } from "node:sqlite";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkIntegrity, sqliteSizes, recentThreadEvents, createHealthMonitor } from "./index.ts";
import { temporary } from "./test-support.ts";
it("read-only integrity checking accepts a real database and does not alter it", async () => {
  const path = join(await temporary(), "events.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE example (value TEXT); INSERT INTO example VALUES ('safe')");
  db.close();
  const before = await readFile(path);
  expect(await checkIntegrity(path, AbortSignal.timeout(5000))).toBe("ok");
  expect(await readFile(path)).toEqual(before);
  expect((await sqliteSizes(path, AbortSignal.timeout(5000))).pageBytes).toBe(
    (await stat(path)).size,
  );
});
it("a deliberately corrupted SQLite file reports corruption rather than creating or repairing it", async () => {
  const path = join(await temporary(), "events.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE example (value TEXT); INSERT INTO example VALUES ('safe')");
  db.close();
  const handle = await open(path, "r+");
  await handle.write(Buffer.alloc(100, 0xff), 0, 100, 0);
  await handle.close();
  const before = await readFile(path);
  expect(await checkIntegrity(path, AbortSignal.timeout(5000))).toBe("corrupt");
  expect(await readFile(path)).toEqual(before);
});
it("a missing database is reported without creating it and an aborted check stops", async () => {
  const path = join(await temporary(), "missing.sqlite");
  expect(await checkIntegrity(path, AbortSignal.timeout(5000))).toBe("missing");
  await expect(stat(path)).rejects.toThrow();
  await writeFile(path, "invalid");
  await expect(checkIntegrity(path, AbortSignal.abort())).rejects.toThrow("aborted");
});
it("health includes real SQLite/WAL sizes, process metrics, workload and drop counts", async () => {
  const path = join(await temporary(), "events.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sample(value TEXT)");
  const monitor = createHealthMonitor({
    database: path,
    now: () => 42,
    workload: () => ({ activeSessions: 3, queues: { pending: 7 } }),
    logs: () => ({ dropped: 4, failed: 1, queued: 2 }),
  });
  try {
    const [first, second] = await Promise.all([monitor.collect(), monitor.collect()]);
    expect(first).toEqual(second);
    expect(first.at).toBe(42);
    expect(first.activeSessions).toBe(3);
    expect(first.queues.pending).toBe(7);
    expect(first.memory.rssBytes).toBeGreaterThan(0);
    expect(first.memory.heapUsedBytes).toBeGreaterThan(0);
    expect(first.openHandles).toBeGreaterThanOrEqual(0);
    expect(first.sqlite.pageBytes).toBe(8192);
    expect(first.sqlite.walBytes).toBe((await stat(path + "-wal")).size);
    expect(first.logs).toEqual({ dropped: 4, failed: 1, queued: 2 });
  } finally {
    monitor.close();
    db.close();
  }
  await expect(monitor.collect()).rejects.toThrow("closed");
});
it("thread export reads recent events with bounded oversized payloads", async () => {
  const path = join(await temporary(), "events.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE events(seq INTEGER PRIMARY KEY, at INTEGER, type TEXT, payload TEXT)");
  const insert = db.prepare("INSERT INTO events VALUES (?, 0, 'event', ?)");
  db.exec("BEGIN");
  for (let n = 1; n <= 2001; n++)
    insert.run(
      n,
      n === 2001 ? "x".repeat(100000) : n === 2000 ? "é".repeat(40000) : '{"value":"safe"}',
    );
  db.exec("COMMIT");
  db.close();
  const lines: string[] = [];
  for await (const line of recentThreadEvents(path)) lines.push(line);
  expect(lines).toHaveLength(2000);
  expect(JSON.parse(lines[0] ?? "null").seq).toBe(2);
  expect(lines.at(-1)).toContain("OVERSIZED EVENT OMITTED");
  expect(lines.at(-2)).toContain("OVERSIZED EVENT OMITTED");
  expect(lines.at(-1)?.length).toBeLessThan(200);
});

it("health converts loop delay to milliseconds and resets the measured interval after collection", async () => {
  const path = join(await temporary(), "events.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE example(value TEXT)");
  db.close();
  let samples = 2;
  const monitor = createHealthMonitor({
    database: path,
    now: () => 0,
    workload: () => ({ activeSessions: 0, queues: {} }),
    logs: () => ({ dropped: 0, failed: 0, queued: 0 }),
    delay: {
      get count() {
        return samples;
      },
      mean: 1500000,
      max: 3000000,
      percentile: () => 2500000,
      enable() {},
      disable() {},
      reset() {
        samples = 0;
      },
    },
  });
  try {
    expect((await monitor.collect()).eventLoop).toEqual({ meanMs: 1.5, p99Ms: 2.5, maxMs: 3 });
    expect((await monitor.collect()).eventLoop).toEqual({ meanMs: null, p99Ms: null, maxMs: null });
  } finally {
    monitor.close();
  }
});
