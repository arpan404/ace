import {
  startStallWatchdog,
  stallFields,
  systemHeartbeat,
  takePreviousStallReports,
  type StallOperation,
  type StallWatchdogOptions,
  type StallWatchdogTiming,
} from "@ace/diagnostics/stall";
import { Worker } from "node:worker_threads";
import type { Log } from "../log/desktop-log.ts";

export interface FreezeWatchOptions {
  log: Log;
  /** Where a freeze still in progress is written, so a force-quit run is reported next start. */
  directory: string;
  pid: number;
  /** What the main thread marks as its current operation. */
  operation: StallOperation;
  /** Starts the watchdog thread; the packaged app loads it from outside the asar archive. */
  spawn?: StallWatchdogOptions["spawn"];
  timing?: Partial<StallWatchdogTiming>;
}

/**
 * The desktop main process freezes for the same reasons the daemon can (a long synchronous
 * task, a huge allocation), and a frozen main process also misreads every timer it owns. A
 * worker thread watches its heartbeat, reads its JavaScript stack and memory on a long stall,
 * and writes the stall to disk while it lasts, so a run the person had to force quit is still
 * explained by the next start.
 */
export function watchFreezes(options: FreezeWatchOptions): () => Promise<void> {
  const { log } = options;
  for (const report of takePreviousStallReports(options.directory, options.pid))
    log(
      "warn",
      "The app's main process froze before it last closed",
      Object.fromEntries([
        ["previousPid", report.pid],
        ["frozenSince", new Date(report.silentSince).toISOString()],
        ...stallFields(report),
      ]),
    );
  try {
    return startStallWatchdog({
      directory: options.directory,
      pid: options.pid,
      clock: systemHeartbeat,
      operation: options.operation,
      // Shorter than the daemon's: two seconds of a frozen window is already felt.
      timing: { thresholdMs: 2_000, ...options.timing },
      ...(options.spawn ? { spawn: options.spawn } : {}),
      onStall: (report) =>
        log(
          "warn",
          report.kind === "io" ? "The app's thread pool stalled" : "The app's main process froze",
          Object.fromEntries(stallFields(report)),
        ),
      onError: (error) => log("warn", "Freeze watchdog failed", { error: String(error) }),
    });
  } catch (error) {
    log("warn", "Freeze watchdog unavailable", { error: String(error) });
    return async () => {};
  }
}

/** The watchdog thread's bundle, written beside the main bundle (`scripts/common.ts`). */
export const STALL_WORKER_BUNDLE = "stall-watchdog-worker.mjs";

/**
 * Where the bundled watchdog thread loads from, given the main bundle's URL. Electron reads
 * the archive for the main process, but a worker's module loader does not, so the bundle is
 * kept unpacked beside it (`asarUnpack`).
 */
export function stallWorkerUrl(mainUrl: string): URL {
  const url = new URL(`./${STALL_WORKER_BUNDLE}`, mainUrl);
  url.pathname = url.pathname.replace(/\/app\.asar\//, "/app.asar.unpacked/");
  return url;
}

/** Spawns the bundled watchdog thread instead of the package's source entry. */
export function bundledStallWorker(mainUrl: string): NonNullable<StallWatchdogOptions["spawn"]> {
  return (_source, workerData) => new Worker(stallWorkerUrl(mainUrl), { workerData });
}
