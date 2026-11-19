import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect } from "vitest";
import type { StallReport } from "./stall-report.ts";
import type { StallOperation } from "./stall-operation.ts";
import { startStallWatchdog, systemHeartbeat, takePreviousStallReports } from "./stall-watchdog.ts";

/** Shared by the stall watchdog's process tests. */
const timing = {
  beatMs: 50,
  checkMs: 50,
  thresholdMs: 400,
  repeatMs: 10_000,
  cooldownMs: 0,
  ioEveryMs: 50,
  ioThresholdMs: 400,
};

/** Watches this process while `run` freezes it, and returns the reports once one arrives. */
export async function watched(
  run: () => unknown,
  operation?: StallOperation,
): Promise<StallReport[]> {
  const directory = mkdtempSync(join(tmpdir(), "stall-watchdog-"));
  const reports: StallReport[] = [];
  const errors: unknown[] = [];
  const stop = startStallWatchdog({
    directory,
    pid: process.pid,
    clock: systemHeartbeat,
    timing,
    onStall: (report) => reports.push(report),
    onError: (error) => errors.push(error),
    ...(operation ? { operation } : {}),
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

export function describeCount(row: object | undefined): string {
  return `counted ${Object.values(row ?? {}).join(",")}`;
}

export function busyLoopFor(ms: number): number {
  const end = performance.now() + ms;
  let spins = 0;
  while (performance.now() < end) spins++;
  return spins;
}

/**
 * Runs a child that freezes for good, kills it once its report on disk satisfies `ready`, and
 * returns what the next start reads, then what a second read gets.
 */
export async function killedWhileFrozen(
  ready: (recorded: Partial<StallReport>) => boolean,
): Promise<{ pid: number | undefined; first: StallReport[]; again: StallReport[] }> {
  const directory = mkdtempSync(join(tmpdir(), "stall-killed-"));
  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, "stall-watchdog-child.ts"), directory],
    { stdio: "ignore" },
  );
  try {
    const path = join(directory, `stall-${child.pid}.json`);
    for (let waited = 0; waited < 15_000; waited += 100) {
      await delay(100);
      if (!existsSync(path)) continue;
      let recorded: Partial<StallReport>;
      try {
        recorded = JSON.parse(readFileSync(path, "utf8")) as Partial<StallReport>;
      } catch {
        continue;
      }
      if (ready(recorded)) break;
    }
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    const first = takePreviousStallReports(directory, process.pid);
    return { pid: child.pid, first, again: takePreviousStallReports(directory, process.pid) };
  } finally {
    child.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
}
