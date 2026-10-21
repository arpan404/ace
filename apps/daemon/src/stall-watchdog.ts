import { Worker } from "node:worker_threads";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { LoopClock } from "./loop-monitor.ts";
import { StallReport } from "./stall-report.ts";

export interface StallWatchdogTiming {
  /** How often the main thread beats. Cheap: one atomic add. */
  beatMs: number;
  /** How often the watchdog thread reads the beat. */
  checkMs: number;
  /** Main-thread silence that counts as a stall and is looked at. */
  thresholdMs: number;
  /** While one stall lasts, look again after this much more silence. */
  repeatMs: number;
  maxCaptures: number;
  /** A new short stall right after a look is not looked at again within this window. */
  cooldownMs: number;
  /** How often the watchdog sends one file-system call through Node's shared thread pool. */
  ioEveryMs: number;
  /** A thread pool call unanswered this long is a stall of its own. */
  ioThresholdMs: number;
}
export const defaultStallTiming: StallWatchdogTiming = {
  beatMs: 250,
  checkMs: 250,
  thresholdMs: 3_000,
  repeatMs: 15_000,
  maxCaptures: 4,
  cooldownMs: 60_000,
  ioEveryMs: 1_000,
  ioThresholdMs: 10_000,
};
export type StallWorkerFactory = (url: URL, workerData: unknown) => Worker;
export interface StallWatchdogOptions {
  /** Where an unfinished stall is written while it lasts; the next start reads it back. */
  directory: string;
  pid: number;
  clock: LoopClock;
  timing?: Partial<StallWatchdogTiming>;
  /** A stall the main thread came back from, with where it was stuck. */
  onStall(report: StallReport): void;
  onError(error: unknown): void;
  spawn?: StallWorkerFactory;
}

const reportName = /^stall-(\d+)\.json(\.partial)?$/;

/**
 * Names the cause of the next main-thread freeze. A worker thread watches a heartbeat the main
 * thread bumps; when it stops, the worker reads the main thread's JavaScript stack through the
 * inspector. Idle cost: one timer per thread and one shared integer.
 */
export function startStallWatchdog(options: StallWatchdogOptions): () => Promise<void> {
  const timing = { ...defaultStallTiming, ...options.timing };
  mkdirSync(options.directory, { recursive: true });
  const heartbeat = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const spawn: StallWorkerFactory =
    options.spawn ?? ((url, workerData) => new Worker(url, { workerData }));
  const worker = spawn(new URL("./stall-watchdog-worker.ts", import.meta.url), {
    ...timing,
    heartbeat,
    pid: options.pid,
    reportPath: join(options.directory, `stall-${options.pid}.json`),
  });
  // Diagnostics never keep the daemon alive.
  worker.unref();
  worker.on("message", (message: unknown) => {
    const report = StallReport.safeParse(message);
    if (report.success) options.onStall(report.data);
  });
  worker.on("error", (error: unknown) => options.onError(error));
  const stop = options.clock.every(timing.beatMs, function stallHeartbeat() {
    Atomics.add(heartbeat, 0, 1);
  });
  return async () => {
    stop();
    await worker.terminate();
  };
}

/**
 * Stalls a previous daemon run recorded and never came back from (it was killed while frozen).
 * Each report is returned once: reading removes it. The current run's own report is left alone.
 */
export function takePreviousStallReports(directory: string, pid: number): StallReport[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const reports: StallReport[] = [];
  for (const name of names) {
    const match = reportName.exec(name);
    if (!match || Number(match[1]) === pid) continue;
    const path = join(directory, name);
    // A write interrupted by the kill: the finished report beside it, if any, is the record.
    if (match[2]) {
      rmSync(path, { force: true });
      continue;
    }
    try {
      const report = StallReport.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (report.success) reports.push(report.data);
    } catch {
      // An unreadable report has nothing to tell; it is removed like the others.
    }
    rmSync(path, { force: true });
  }
  return reports.toSorted((a, b) => a.silentSince - b.silentSince);
}
