import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { systemLoopClock } from "./loop-monitor.ts";
import type { StallReport } from "./stall-report.ts";
import { startStallWatchdog, takePreviousStallReports } from "./stall-watchdog.ts";

const timing = { beatMs: 50, checkMs: 50, thresholdMs: 400, repeatMs: 10_000, cooldownMs: 0 };

async function watched(run: () => void): Promise<StallReport[]> {
  const directory = mkdtempSync(join(tmpdir(), "stall-watchdog-"));
  const reports: StallReport[] = [];
  const errors: unknown[] = [];
  const stop = startStallWatchdog({
    directory,
    pid: process.pid,
    clock: systemLoopClock,
    timing,
    onStall: (report) => reports.push(report),
    onError: (error) => errors.push(error),
  });
  try {
    // Let the worker start and see the heartbeat before the main thread freezes.
    await delay(500);
    run();
    for (let waited = 0; !reports.length && waited < 5_000; waited += 50) await delay(50);
    expect(errors).toEqual([]);
    return reports;
  } finally {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

function describeCount(row: object | undefined): string {
  return `counted ${Object.values(row ?? {}).join(",")}`;
}

function busyLoopFor(ms: number): number {
  const end = performance.now() + ms;
  let spins = 0;
  while (performance.now() < end) spins++;
  return spins;
}

test("a main thread stuck in JavaScript is reported with the function it was stuck in", async () => {
  const reports = await watched(function freezeInJavaScript() {
    busyLoopFor(1_500);
  });
  expect(reports).toHaveLength(1);
  const [report] = reports;
  expect(report).toMatchObject({ pid: process.pid, caught: true, ended: true });
  expect(report?.silentMs).toBeGreaterThanOrEqual(1_000);
  expect(report?.stack.map((frame) => frame.fn)).toContain("busyLoopFor");
  expect(report?.stack.map((frame) => frame.fn)).toContain("freezeInJavaScript");
});

test("a main thread stuck in one long SQLite statement is reported with the caller of that statement", async () => {
  const count =
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<?) SELECT count(*) FROM c";
  const db = new DatabaseSync(":memory:");
  try {
    const sample = 200_000;
    const started = performance.now();
    db.prepare(count).get(sample);
    // Rows for one native call that holds the thread about 1.5 s.
    const rows = Math.ceil((sample * 1_500) / Math.max(1, performance.now() - started));
    const reports = await watched(function freezeInSqlite() {
      const counted = db.prepare(count).get(rows);
      // Like a transaction committing: the caller carries on in JavaScript.
      return describeCount(counted);
    });
    expect(reports).toHaveLength(1);
    const [report] = reports;
    expect(report).toMatchObject({ caught: true, ended: true });
    expect(report?.stack.map((frame) => frame.fn)).toContain("freezeInSqlite");
    // The stack arrives only once the statement returns: the wait shows it sat in native code.
    expect(report?.answerMs).toBeGreaterThan(300);
  } finally {
    db.close();
  }
});

test("a run killed while frozen leaves its stall for the next start to report once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "stall-killed-"));
  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, "stall-watchdog-child.ts"), directory],
    { stdio: "ignore" },
  );
  try {
    const path = join(directory, `stall-${child.pid}.json`);
    let recorded: unknown;
    for (let waited = 0; waited < 15_000; waited += 100) {
      await delay(100);
      if (!existsSync(path)) continue;
      try {
        recorded = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        continue;
      }
      if ((recorded as { stack?: unknown[] }).stack?.length) break;
    }
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    const reports = takePreviousStallReports(directory, process.pid);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ pid: child.pid, ended: false, caught: true });
    expect(reports[0]?.stack.map((frame) => frame.fn)).toContain("freezeForever");
    expect(takePreviousStallReports(directory, process.pid)).toEqual([]);
  } finally {
    child.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});
