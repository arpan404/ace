import { monitorEventLoopDelay } from "node:perf_hooks";
import { DiagnosticsHealth } from "@ace/protocol";
import { sqliteSizes } from "./sqlite.ts";
export interface DelayProbe {
  count: number;
  mean: number;
  max: number;
  percentile(percentile: number): number;
  enable(): unknown;
  disable(): unknown;
  reset(): void;
}
export interface HealthRuntime {
  createDelay(): DelayProbe;
  memory(): { rss: number; heapUsed: number; heapTotal: number };
  resources(): readonly string[];
  sqlite: typeof sqliteSizes;
  schedule(callback: () => void, milliseconds: number): () => void;
  deadlineMs: number;
}
const systemHealth: HealthRuntime = {
  createDelay: () => monitorEventLoopDelay({ resolution: 20 }),
  memory: process.memoryUsage,
  resources: process.getActiveResourcesInfo,
  sqlite: sqliteSizes,
  schedule(callback, ms) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
  deadlineMs: 1000,
};
export interface HealthOptions {
  /** Inject time measurements without sleeps in tests. */
  delay?: DelayProbe;
  database: string;
  now: () => number;
  workload: () => { activeSessions: number | null; queues: Record<string, number> };
  logs: () => { dropped: number; failed: number; queued: number; directory?: string };
}
export function createHealthMonitor(options: HealthOptions, runtime: HealthRuntime = systemHealth) {
  if (!Number.isFinite(runtime.deadlineMs) || runtime.deadlineMs < 1)
    throw new RangeError("Invalid health deadline");
  const histogram = options.delay ?? runtime.createDelay();
  histogram.enable();
  let collecting: Promise<DiagnosticsHealth> | undefined;
  let closed = false;
  let controller: AbortController | undefined;
  return {
    collect(): Promise<DiagnosticsHealth> {
      if (closed) return Promise.reject(new Error("Health monitor closed"));
      collecting ??= (async () => {
        controller = new AbortController();
        const cancel = runtime.schedule(() => controller?.abort(), runtime.deadlineMs);
        try {
          const sqlite = await runtime.sqlite(options.database, controller.signal);
          const memory = runtime.memory();
          const delay = (value: number) =>
            histogram.count > 0 && Number.isFinite(value) ? value / 1e6 : null;
          const health = DiagnosticsHealth.parse({
            at: options.now(),
            eventLoop: {
              meanMs: delay(histogram.mean),
              p99Ms: delay(histogram.percentile(99)),
              maxMs: delay(histogram.max),
            },
            memory: {
              rssBytes: memory.rss,
              heapUsedBytes: memory.heapUsed,
              heapTotalBytes: memory.heapTotal,
            },
            openHandles: runtime.resources().length,
            sqlite,
            ...options.workload(),
            logs: options.logs(),
          });
          histogram.reset();
          return health;
        } finally {
          cancel();
        }
      })().finally(() => {
        collecting = undefined;
      });
      return collecting;
    },
    close() {
      closed = true;
      histogram.disable();
      controller?.abort();
    },
  };
}
