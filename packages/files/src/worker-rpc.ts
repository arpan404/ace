// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import type { Worker } from "node:worker_threads";
import { FileError } from "./types.ts";

/** Single-owner I/O request, with explicit admission instead of an unbounded worker queue. */
export function workerRequest(createWorker: () => Worker) {
  let worker: Worker | undefined;
  let closed = false;
  let problem: Error | undefined;
  let waiting: { resolve(value: unknown): void; reject(error: Error): void } | undefined;
  const fail = (error: Error) => {
    problem = error;
    waiting?.reject(error);
    waiting = undefined;
  };
  return {
    async request(input: unknown): Promise<unknown> {
      if (closed) throw new FileError("CLOSED", "Worker owner closed");
      if (problem) throw problem;
      if (waiting) throw new FileError("BUSY", "Worker already has a request");
      if (!worker) {
        worker = createWorker();
        worker.on("error", fail);
        worker.on("exit", () => fail(new FileError("IO_ERROR", "I/O worker exited")));
        worker.on("message", (value: unknown) => {
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
      fail(new FileError("CLOSED", "Worker owner closed"));
      await worker?.terminate();
    },
  };
}
