import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { Worker } from "node:worker_threads";

/** The I/O shell supplies process, worker and deadline ownership to search logic. */
export type WorkspaceProcessSpawner = (
  binary: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;
export interface WorkspaceRuntime {
  spawn: WorkspaceProcessSpawner;
  createWorker(url: URL): Worker;
  deadline(ms: number, expire: () => void): () => void;
}
export function workspaceRuntime(overrides: Partial<WorkspaceRuntime> = {}): WorkspaceRuntime {
  return {
    spawn,
    createWorker: (url) => new Worker(url, { execArgv: [] }),
    deadline(ms, expire) {
      const timer = setTimeout(expire, ms);
      return () => clearTimeout(timer);
    },
    ...overrides,
  };
}
