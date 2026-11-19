import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { type Stats } from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { win32 } from "node:path";
import { openMetadataAt, openRoot } from "./descriptor.ts";
import { canonicalPath } from "./realpath.ts";

export interface WorkspaceFileSystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<Stats>;
  lstat(path: string): Promise<Stats>;
  open(path: string, flags: number): Promise<FileHandle>;
}
export const filesystem: WorkspaceFileSystem = { realpath: canonicalPath, stat, lstat, open };
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
export interface WorkspaceRuntime {
  environment: NodeJS.ProcessEnv;
  /** Selects the path rules (Windows' reserved names, case, separators). */
  platform: NodeJS.Platform;
  filesystem: WorkspaceFileSystem;
  spawn: (binary: string, args: string[], options: SpawnOptions) => ChildProcess;
}
/** Defaults are assembled at the I/O boundary, with no state shared by services. */
export function workspaceRuntime(): WorkspaceRuntime {
  return {
    environment: { ...process.env },
    platform: process.platform,
    filesystem,
    spawn,
  };
}
