const noop = () => {};
import { Worker } from "node:worker_threads";
import type { LogWorkerRuntime } from "./worker-sink.ts";
import { z } from "zod";
/** Pull one bounded batch at a time. The bundle owns this generator's lifetime. */
export async function* recentThreadEvents(
  path: string,
  runtime: LogWorkerRuntime = {
    spawn: (url, data) => new Worker(url, { workerData: data }),
    schedule(callback, ms) {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
    deadlineMs: 5000,
  },
): AsyncIterable<string> {
  const worker = runtime.spawn(new URL("./thread-worker.ts", import.meta.url), { path });
  let failure: Error | undefined;
  let pending: { resolve: (input: unknown) => void; reject: (error: Error) => void } | undefined;
  worker.on("error", (error: unknown) => {
    failure = error instanceof Error ? error : new Error("Thread export failed");
    pending?.reject(failure);
  });
  worker.on("exit", () => {
    failure ??= new Error("Thread export exited");
    pending?.reject(failure);
  });
  worker.on("message", (input: unknown) => {
    pending?.resolve(input);
    pending = undefined;
  });
  try {
    for (;;) {
      let cancel = noop;
      const input: unknown = await new Promise((resolve, reject) => {
        if (failure) {
          reject(failure);
          return;
        }
        pending = { resolve, reject };
        cancel = runtime.schedule(() => {
          reject(new Error("Thread export timed out"));
          void worker.terminate();
        }, runtime.deadlineMs);
        worker.postMessage("next", []);
      }).finally(() => cancel());
      const result = z
        .object({ done: z.boolean(), lines: z.array(z.string().max(128000)).max(16) })
        .parse(input);
      for (const line of result.lines) yield line;
      if (result.done) return;
    }
  } finally {
    await worker.terminate();
  }
}
