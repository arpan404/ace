import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { watch, type Stats, type FSWatcher } from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { Worker } from "node:worker_threads";

export interface WorkspaceFileSystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<Stats>;
  lstat(path: string): Promise<Stats>;
  open(path: string, flags: number): Promise<FileHandle>;
}
export const filesystem: WorkspaceFileSystem = { realpath, stat, lstat, open };
export type CancelTimer = () => void;
export interface WorkspaceClock {
  after(callback: () => void | Promise<void>, milliseconds: number): CancelTimer;
  every(callback: () => void, milliseconds: number): CancelTimer;
}
export interface WorkspaceRuntime {
  filesystem: WorkspaceFileSystem;
  spawn: (binary: string, args: string[], options: SpawnOptions) => ChildProcess;
  worker: (url: URL) => Worker;
  watch: (
    root: string,
    options: { recursive: boolean },
    listener: (event: "rename" | "change", filename: string | null) => void,
  ) => FSWatcher;
  clock: WorkspaceClock;
}
/** Defaults are assembled at the I/O boundary, with no state shared by services. */
export function workspaceRuntime(): WorkspaceRuntime {
  return {
    filesystem,
    spawn,
    watch,
    worker: (url) => new Worker(url, { execArgv: [] }),
    clock: {
      after(callback, milliseconds) {
        const timer = setTimeout(callback, milliseconds);
        return () => clearTimeout(timer);
      },
      every(callback, milliseconds) {
        const timer = setInterval(callback, milliseconds);
        return () => clearInterval(timer);
      },
    },
  };
}
