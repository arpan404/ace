import { IdleWorker } from "@ace/provider-kit/idle-worker";

/** Worker I/O boundary for WAL checkpoints; tests and in-memory stores substitute it. */
export interface CheckpointWorker {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  terminate(): Promise<number>;
  idle?(): void;
}
export type CheckpointWorkerFactory = (path: string) => CheckpointWorker;

export function spawnCheckpointWorker(path: string): CheckpointWorker {
  return new IdleWorker(new URL("./wal-checkpoint-worker.ts", import.meta.url), {
    workerData: { path },
  });
}
