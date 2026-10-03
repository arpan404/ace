import { Worker } from "node:worker_threads";

/** Worker I/O boundary, injectable without exposing the reader's pending map. */
export interface SearchWorker {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  terminate(): Promise<number>;
}
export type SearchWorkerFactory = (path: string) => SearchWorker;

export function spawnSearchWorker(path: string): SearchWorker {
  return new Worker(new URL("./query-worker.ts", import.meta.url), { workerData: { path } });
}
