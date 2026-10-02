import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { RedactionContext } from "@ace/redaction";
import type { BatchSink, LogRecord } from "./logger.ts";
import type { FileSinkOptions } from "./file-sink.ts";
export async function createFileSink(
  options: FileSinkOptions & { context: RedactionContext },
): Promise<BatchSink> {
  const worker = new Worker(new URL("./log-worker.ts", import.meta.url), { workerData: options });
  let pending: { resolve: () => void; reject: (error: Error) => void } | undefined;
  let failure: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    timer = setTimeout(() => {
      fail(new Error("Log worker timed out"));
      void worker.terminate();
    }, 5000);
  };
  const ready = new Promise<void>((resolve, reject) => {
    pending = { resolve, reject };
  });
  const fail = (error: Error) => {
    if (timer) clearTimeout(timer);
    failure = error;
    pending?.reject(error);
    pending = undefined;
  };
  worker.on("error", fail);
  worker.on("exit", (code) => {
    if (code !== 0 || pending) fail(new Error("Log worker stopped"));
  });
  arm();
  worker.on("message", (input: unknown) => {
    if (timer) clearTimeout(timer);
    const parsed = z
      .object({ ready: z.boolean().optional(), ok: z.boolean().optional() })
      .safeParse(input);
    if (!parsed.success) {
      fail(new Error("Invalid log acknowledgement"));
      return;
    }
    if (parsed.data.ready || parsed.data.ok) pending?.resolve();
    else pending?.reject(new Error("Log write failed"));
    pending = undefined;
  });
  try {
    await ready;
  } catch (error) {
    await worker.terminate();
    throw error;
  }
  return {
    write(records: readonly LogRecord[]) {
      if (failure) return Promise.reject(failure);
      if (pending) return Promise.reject(new Error("Only one log batch may be outstanding"));
      return new Promise<void>((resolve, reject) => {
        pending = { resolve, reject };
        arm();
        worker.postMessage(records, []);
      });
    },
    async close() {
      if (timer) clearTimeout(timer);
      await worker.terminate();
    },
  };
}
