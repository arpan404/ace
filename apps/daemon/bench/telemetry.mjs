// Measurement-only preload. Each isolate reports its own heap; RSS and CPU are process-wide.
import { threadId, isMainThread } from "node:worker_threads";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const directory = process.env.ACE_PERF_TELEMETRY;
if (directory) {
  const sample = () =>
    writeFileSync(
      join(directory, `${threadId}.json`),
      JSON.stringify({
        threadId,
        isMainThread,
        runtime: process.version,
        at: Date.now(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
      }),
    );
  sample();
  setInterval(sample, 500).unref();
}
