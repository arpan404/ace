import { Worker } from "node:worker_threads";
import { z } from "zod";
/** Pull one bounded batch at a time. The bundle owns this generator's lifetime. */
export async function* recentThreadEvents(path: string): AsyncIterable<string> {
  const worker = new Worker(new URL("./thread-worker.ts", import.meta.url), {
    workerData: { path },
  });
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
      const input: unknown = await new Promise((resolve, reject) => {
        if (failure) {
          reject(failure);
          return;
        }
        pending = { resolve, reject };
        worker.postMessage("next", []);
      });
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
