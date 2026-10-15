import { mkdtemp, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { accessRequest } from "./client-access.ts";
import { daemonLogRecords } from "./daemon-log-test-support.ts";
import { readConfig, startDaemon } from "./index.ts";

function sqliteFull(): Error {
  // A genuine node:sqlite SQLITE_FULL: this database may not grow past two pages.
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE t(x); PRAGMA max_page_count=2");
    for (;;) db.prepare("INSERT INTO t VALUES (?)").run("x".repeat(4096));
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  } finally {
    db.close();
  }
}

test("a background storage pass that hits a full disk is logged with the free space and the daemon keeps serving", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-disk-full-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const startupMs = 54_321;
  const scheduled: { delay: number; work: () => void }[] = [];
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0" }),
    diskSpace: () => ({ bavail: 7, bsize: 4096 }),
    retentionTiming: { startupMs, intervalMs: 3_600_000, changeMs: 2_000, retryMs: 60_000 },
    storageSchedule: (delay, work) => {
      const entry = { delay, work };
      scheduled.push(entry);
      return () => scheduled.splice(scheduled.indexOf(entry) >>> 0, 1);
    },
  });
  onTestFinished(() => daemon.close());
  const storage = daemon.storage;
  if (!storage) throw new Error("Storage service did not start");
  // The disk boundary: this pass's storage write fails exactly as a full volume makes it fail.
  storage.retain = () => Promise.reject(sqliteFull());
  const pass = scheduled.find((entry) => entry.delay === startupMs);
  if (!pass) throw new Error("Retention pass was not scheduled");
  pass.work();
  for (
    let attempt = 0;
    attempt < 100 && !scheduled.some((entry) => entry.delay === 60_000);
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  // The failed pass schedules its retry, and the daemon still answers.
  expect(scheduled.map((entry) => entry.delay)).toContain(60_000);
  const origin = await readFile(join(home, "daemon-endpoint"), "utf8");
  const token = await readFile(daemon.tokenPath, "utf8");
  expect(await accessRequest(origin, "/v1/status", { token })).toMatchObject({ running: true });
  await daemon.close();
  expect(await daemonLogRecords(home)).toContainEqual(
    expect.objectContaining({
      level: "error",
      message: "Data retention failed",
      data: expect.objectContaining({
        error: expect.objectContaining({ message: "database or disk is full" }),
        sqlite: "SQLITE_FULL",
        freeBytes: 7 * 4096,
      }),
    }),
  );
});
