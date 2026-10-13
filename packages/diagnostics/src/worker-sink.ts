import { isWorkerRuntimeMessage } from "@ace/provider-kit/idle-worker";
import type { Worker } from "node:worker_threads";
import { z } from "zod";
import type { RedactionContext } from "@ace/redaction";
import type { BatchSink, LogRecord } from "./logger.ts";
import type { FileSinkOptions } from "./file-sink.ts";
import { appendLogLinesSync, openFileSink } from "./file-sink.ts";
import { createDiagnosticRedactor } from "@ace/redaction/diagnostic";
export interface LogWorkerRuntime {
  spawn(url: URL, data: unknown): Pick<Worker, "on" | "postMessage" | "terminate">;
  schedule(callback: () => void, milliseconds: number): () => void;
  deadlineMs: number;
}
export async function createFileSink(
  options: FileSinkOptions & { context: RedactionContext },
  runtime?: LogWorkerRuntime,
): Promise<BatchSink> {
  const redact = createDiagnosticRedactor(options.context);
  const lines = (records: readonly LogRecord[]) =>
    records.map((entry) => redact(JSON.stringify(entry)) + "\n");
  // Crash-path appends rescan the directory, so they need only the latest cap.
  let limits: FileSinkOptions = {
    directory: options.directory,
    totalBytes: options.totalBytes,
    ...(options.fileBytes !== undefined ? { fileBytes: options.fileBytes } : {}),
  };
  const writeSync = (records: readonly LogRecord[]) => appendLogLinesSync(limits, lines(records));
  if (!runtime) {
    const sink = await openFileSink(options);
    // The logger bounds and serializes batches. File writes and rotation already use async I/O.
    return {
      async write(records) {
        await sink.write(lines(records));
      },
      async resize(totalBytes) {
        await sink.resize(totalBytes);
        limits = { ...limits, totalBytes };
      },
      writeSync,
      async close() {},
    };
  }
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
    if (isWorkerRuntimeMessage(input)) return;
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
  const send = (message: unknown) => {
    if (failure) return Promise.reject(failure);
    if (pending) return Promise.reject(new Error("Only one log batch may be outstanding"));
    return new Promise<void>((resolve, reject) => {
      pending = { resolve, reject };
      arm();
      worker.postMessage(message, []);
    });
  };
  return {
    write: (records: readonly LogRecord[]) => send({ type: "write", records }),
    async resize(totalBytes: number) {
      await send({ type: "resize", totalBytes });
      limits = { ...limits, totalBytes };
    },
    writeSync,
    async close() {
      cancel?.();
      await worker.terminate();
    },
  };
}
