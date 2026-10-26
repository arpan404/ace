import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { watch, type Stats, type FSWatcher } from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { win32 } from "node:path";
import { Worker } from "node:worker_threads";
import { openMetadataAt, openRoot } from "./descriptor.ts";

export interface WorkspaceFileSystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<Stats>;
  lstat(path: string): Promise<Stats>;
  open(path: string, flags: number): Promise<FileHandle>;
}
export const filesystem: WorkspaceFileSystem = { realpath, stat, lstat, open };
if (process.platform === "win32")
  Object.assign(filesystem, { stat: windowsStat, lstat: windowsLstat });

// Windows path metadata through pinned handles, so identities match descriptor stats. stat
// resolves the whole path; lstat resolves only the parent and describes the leaf itself.
async function windowsObserve(parentPath: string, leaf?: string): Promise<Stats> {
  const parent = openRoot(parentPath);
  try {
    if (leaf === undefined) return await parent.stat();
    const child = openMetadataAt(parent.fd, leaf);
    try {
      return await child.stat();
    } finally {
      await child.close();
    }
  } finally {
    await parent.close();
  }
}
function windowsPinned(canonical: string): Promise<Stats> {
  if (win32.dirname(canonical) === canonical) return windowsObserve(canonical);
  return windowsObserve(win32.dirname(canonical), win32.basename(canonical));
}
/** UNC, device and drive-relative paths are refused before realpath can rewrite them. */
async function windowsRootAllowed(path: string): Promise<void> {
  const root = win32.parse(path).root;
  if (root !== "" && (root.length !== 3 || root[1] !== ":")) await openRoot(path).close();
}
async function windowsStat(path: string): Promise<Stats> {
  await windowsRootAllowed(path);
  return windowsPinned(await realpath(path));
}
async function windowsLstat(path: string): Promise<Stats> {
  await windowsRootAllowed(path);
  const leaf = win32.basename(path);
  if (leaf === "" || leaf === "." || leaf === "..") return windowsPinned(await realpath(path));
  return windowsObserve(await realpath(win32.dirname(path)), leaf);
}
export type CancelTimer = () => void;
export interface WorkspaceClock {
  after(callback: () => void | Promise<void>, milliseconds: number): CancelTimer;
  every(callback: () => void, milliseconds: number): CancelTimer;
}
export interface WorkspaceRuntime {
  environment: NodeJS.ProcessEnv;
  /** Selects the native watch strategy (Linux watches each visible directory) and path rules. */
  platform: NodeJS.Platform;
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
    environment: { ...process.env },
    platform: process.platform,
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
