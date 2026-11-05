// Measurement-only preload. Each isolate reports its own heap; RSS and CPU are process-wide.
import { threadId, isMainThread, Worker, BroadcastChannel } from "node:worker_threads";
import { channel as diagnosticsChannel } from "node:diagnostics_channel";
import { writeFileSync, renameSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
// Held for the process's life: Bun keeps a channel only while something references it, and
// doesn't keep a preload's module scope alive, so a collected channel would leave later worker
// announcements unheard.
const created = diagnosticsChannel("worker_threads");
Reflect.set(globalThis, "acePerfWorkerChannel", created);
const directory = process.env.ACE_PERF_TELEMETRY;
if (directory) {
  const workers = new Set();
  const pending = new Set();
  let generation = 0;
  const channel = new BroadcastChannel(`ace-perf:${directory}`);
  channel.unref();
  const Ready = z.object({ threadId: z.number().int().positive() });
  const Ownership = z.object({
    workerIds: z.array(z.number().int().positive()),
    pendingWorkerIds: z.array(z.number().int().positive()),
  });
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
        // Bun's --expose-gc reaches only the main isolate; its workers collect with Bun.gc.
        const bun = Reflect.get(globalThis, "Bun");
        const gc = globalThis.gc ?? (bun?.gc ? () => bun.gc(true) : undefined);
        if (!gc) throw new Error("Worker GC was not exposed by the measurement runtime");
        gc();
        gc();
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
        pendingWorkerIds: [...pending],
        generation,
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
  channel.addEventListener("message", ({ data }) => {
    const ready = Ready.parse(data);
    if (!pending.delete(ready.threadId)) return;
    workers.add(ready.threadId);
    generation++;
    sample();
  });
  // Parent publication precedes pruning. Readers verify generations and retry
  // retirement transitions; stable missing files remain corruption.
  const prune = (id) => {
    const file = join(directory, `${id}.json`);
    try {
      const owner = Ownership.parse(JSON.parse(readFileSync(file, "utf8")));
      for (const child of [...owner.workerIds, ...owner.pendingWorkerIds]) prune(child);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    rmSync(file, { force: true });
    rmSync(join(directory, `${id}.tmp`), { force: true });
  };
  // Node announces every new worker here. Bun announces none, so ace's own worker factory
  // (startWorker in @ace/provider-kit/worker) announces the workers it gives this preload.
  created.subscribe((message) => {
    if (!(message?.worker instanceof Worker)) throw new Error("Invalid worker lifecycle event");
    const worker = message.worker;
    const id = worker.threadId;
    pending.add(id);
    generation++;
    sample();
    worker.once("exit", () => {
      workers.delete(id);
      pending.delete(id);
      generation++;
      sample();
      prune(id);
    });
  });
  sample();
  // Node BroadcastChannel has no targetOrigin argument (unlike window.postMessage).
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  if (!isMainThread) channel.postMessage({ threadId });
  setInterval(sample, 500).unref();
}
