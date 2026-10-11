// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import type { Worker } from "node:worker_threads";
import { FileError } from "./types.ts";

/** Single-owner I/O request, with explicit admission instead of an unbounded worker queue. */
export function workerRequest(createWorker: () => Worker) {
  let worker: Worker | undefined;
  let closed = false;
  let waiting: { resolve(value: unknown): void; reject(error: Error): void } | undefined;
  const fail = (error: Error) => {
    const failed = worker;
    worker = undefined;
    if (failed) {
      failed.removeAllListeners();
      failed.on("error", () => {});
      void failed.terminate().catch(() => {});
    }
    waiting?.reject(error);
    waiting = undefined;
  };
  return {
    async request(input: unknown): Promise<unknown> {
      if (closed) throw new FileError("CLOSED", "Worker owner closed");
      if (waiting) throw new FileError("BUSY", "Worker already has a request");
      if (!worker) {
        worker = createWorker();
        worker.on("error", fail);
        worker.on("exit", () => fail(new FileError("IO_ERROR", "I/O worker exited")));
        const current = worker;
        worker.on("message", (value: unknown) => {
          if (worker !== current) return;
          const pending = waiting;
          waiting = undefined;
          pending?.resolve(value);
        });
      }
      const owned = worker;
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        try {
          owned.postMessage(input);
        } catch (error) {
          fail(error instanceof Error ? error : new Error("Worker dispatch failed"));
        }
      });
    },
    async close() {
      closed = true;
      const owned = worker;
      fail(new FileError("CLOSED", "Worker owner closed"));
      await owned?.terminate();
    },
  };
}
