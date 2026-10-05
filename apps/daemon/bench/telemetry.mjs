// Measurement-only preload. Each isolate reports its own heap; RSS and CPU are process-wide.
import { threadId, isMainThread, Worker } from "node:worker_threads";
import { subscribe } from "node:diagnostics_channel";
import { writeFileSync, renameSync, readFileSync } from "node:fs";
import { join } from "node:path";
const directory = process.env.ACE_PERF_TELEMETRY;
if (directory) {
  const workers = new Set();
  let collection = "";
  const sample = () => {
    if (process.env.ACE_PERF_COLLECT_WORKERS) {
      let requested = "";
      try {
        requested = readFileSync(join(directory, "collect"), "utf8");
      } catch {
        /* no collection requested */
      }
      if (requested && requested !== collection) {
        if (!globalThis.gc) throw new Error("Worker GC was not exposed by the measurement runtime");
        globalThis.gc();
        globalThis.gc();
        collection = requested;
      }
    }
    const temporary = join(directory, `${threadId}.tmp`);
    writeFileSync(
      temporary,
      JSON.stringify({
        threadId,
        isMainThread,
        workerIds: [...workers],
        runtime: process.version,
        entry: process.argv[1] ?? "unknown",
        collection,
        at: Date.now(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
      }),
    );
    renameSync(temporary, join(directory, `${threadId}.json`));
  };
  subscribe("worker_threads", (message) => {
    if (!(message?.worker instanceof Worker)) throw new Error("Invalid worker lifecycle event");
    const worker = message.worker;
    const id = worker.threadId;
    workers.add(id);
    sample();
    worker.once("exit", () => {
      workers.delete(id);
      sample();
    });
  });
  sample();
  setInterval(sample, 500).unref();
}
