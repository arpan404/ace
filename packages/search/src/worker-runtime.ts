import { IdleWorker } from "@ace/provider-kit/idle-worker";
import {
  searchWireShape,
  type SearchWorkerData,
  type SearchWorkerRequest,
  type SearchWorkerResult,
} from "./worker-protocol.ts";

/**
 * Worker I/O boundary, injectable without exposing the reader's pending map. Messages are
 * typed, not parsed: the worker is this build (it checks `searchWireShape` when it starts).
 */
export interface SearchWorker {
  postMessage(message: SearchWorkerRequest): void;
  on(event: "message", listener: (message: SearchWorkerResult) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  terminate(): Promise<number>;
  idle?(): void;
}
export type SearchWorkerFactory = (path: string) => SearchWorker;

export function spawnSearchWorker(path: string): SearchWorker {
  const workerData: SearchWorkerData = { path, shape: searchWireShape() };
  return new IdleWorker(new URL("./query-worker.ts", import.meta.url), { workerData });
}
