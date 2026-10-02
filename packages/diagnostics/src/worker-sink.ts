import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { RedactionContext } from "@ace/redaction";
import type { BatchSink, LogRecord } from "./logger.ts";
import type { FileSinkOptions } from "./file-sink.ts";
export interface LogWorkerRuntime {
  spawn(url: URL, data: unknown): Pick<Worker, "on" | "postMessage" | "terminate">;
  schedule(callback: () => void, milliseconds: number): () => void;
  deadlineMs: number;
}
const systemWorker: LogWorkerRuntime = {
  spawn: (url, data) => new Worker(url, { workerData: data }),
  schedule(callback, ms) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
  deadlineMs: 5000,
};
export async function createFileSink(
  options: FileSinkOptions & { context: RedactionContext },
  runtime: LogWorkerRuntime = systemWorker,
): Promise<BatchSink> {
  if (!Number.isFinite(runtime.deadlineMs) || runtime.deadlineMs < 1)
    throw new RangeError("Invalid worker deadline");
  const worker = runtime.spawn(new URL("./log-worker.ts", import.meta.url), options);
  let pending: { resolve: () => void; reject: (error: Error) => void } | undefined;
  let failure: Error | undefined;
  let cancel: (() => void) | undefined;
  const arm = () => {
    cancel = runtime.schedule(() => {
      fail(new Error("Log worker timed out"));
      void worker.terminate();
    }, runtime.deadlineMs);
  };
  const ready = new Promise<void>((resolve, reject) => {
    pending = { resolve, reject };
  });
  const fail = (error: Error) => {
    cancel?.();
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
    cancel?.();
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
      cancel?.();
      await worker.terminate();
    },
  };
}
