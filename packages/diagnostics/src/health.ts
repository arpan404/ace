import { monitorEventLoopDelay } from "node:perf_hooks";
import { DiagnosticsHealth } from "@ace/protocol";
import { sqliteSizes } from "./sqlite.ts";
export interface HealthOptions {
  database: string;
  now: () => number;
  workload: () => { activeSessions: number | null; queues: Record<string, number> };
  logs: () => { dropped: number; failed: number; queued: number };
}
export function createHealthMonitor(options: HealthOptions) {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let collecting: Promise<DiagnosticsHealth> | undefined;
  let closed = false;
  let controller: AbortController | undefined;
  return {
    collect(): Promise<DiagnosticsHealth> {
      if (closed) return Promise.reject(new Error("Health monitor closed"));
      collecting ??= (async () => {
        controller = new AbortController();
        const timer = setTimeout(() => controller?.abort(), 1000);
        try {
          const sqlite = await sqliteSizes(options.database, controller.signal);
          const memory = process.memoryUsage();
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
            openHandles: process.getActiveResourcesInfo().length,
            sqlite,
            ...options.workload(),
            logs: options.logs(),
          });
          histogram.reset();
          return health;
        } finally {
          clearTimeout(timer);
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
