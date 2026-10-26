import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { win32 } from "node:path";
import { posixStats, type IdentifiedStats } from "./file-identity.ts";
import { Worker } from "node:worker_threads";
import { openMetadataAt, openRoot, type Descriptor } from "./descriptor.ts";

export interface WorkspaceFileSystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<IdentifiedStats>;
  lstat(path: string): Promise<IdentifiedStats>;
  open(path: string, flags: number): Promise<FileHandle>;
}
/*
 * Windows path metadata is read through pinned handles: Node's Windows stat has lossy dev/ino
 * and reports a junction as a directory. stat resolves the full path and opens it; lstat
 * resolves only the parent and opens the leaf without following it. These are observations,
 * not authorization; SafeRoot still compares them with its anchored handles.
 */
async function observe(acquire: () => Descriptor): Promise<IdentifiedStats> {
  const handle = acquire();
  try {
    return await handle.stat();
  } finally {
    await handle.close();
  }
}
async function windowsChild(parentPath: string, leaf: string): Promise<IdentifiedStats> {
  const parent = openRoot(parentPath);
  try {
    return await observe(() => openMetadataAt(parent.fd, leaf));
  } finally {
    await parent.close();
  }
}
function windowsPinned(canonical: string): Promise<IdentifiedStats> {
  if (win32.dirname(canonical) === canonical) return observe(() => openRoot(canonical));
  return windowsChild(win32.dirname(canonical), win32.basename(canonical));
}
/** Native policy refuses namespaces, UNC and drive-relative roots before realpath can turn
 * them into an ordinary drive path. */
async function windowsRootAllowed(input: string): Promise<void> {
  const root = win32.parse(input).root;
  if (root !== "" && (root.length !== 3 || root[1] !== ":")) await openRoot(input).close();
}

export const filesystem: WorkspaceFileSystem = {
  realpath,
  async stat(path) {
    if (process.platform === "win32") {
      await windowsRootAllowed(path);
      return windowsPinned(await realpath(path));
    }
    return posixStats(await stat(path, { bigint: true }));
  },
  async lstat(path) {
    if (process.platform === "win32") {
      await windowsRootAllowed(path);
      const leaf = win32.basename(path);
      if (leaf === "" || leaf === "." || leaf === "..") return windowsPinned(await realpath(path));
      return windowsChild(await realpath(win32.dirname(path)), leaf);
    }
    return posixStats(await lstat(path, { bigint: true }));
  },
  open,
};
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
