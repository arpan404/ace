import { close as closeDescriptor, constants } from "node:fs";
import { closeSync, fstatSync, readlinkSync } from "node:fs";
import type { Stats } from "node:fs";
import {
  isAbsolute,
  join as joinPath,
  relative as relativePath,
  resolve as resolvePath,
} from "node:path";
import {
  descriptorNames,
  openAt,
  openMetadataAt,
  openRoot,
  removeDirectoryAt,
  renameAt,
  sameWindowsFile,
  statWindowsFd,
  unlinkAt,
} from "@ace/workspace/descriptor";
import { junctionAt, renameAtNoReplace } from "@ace/workspace/descriptor";
import { directoryFlags } from "./posix-flags.ts";
import { EntryUnavailable, type DirectoryReader, type OpenCommandChild } from "./posix-types.ts";

const closeQuietly = (fd: number) =>
  new Promise<void>((accept) => closeDescriptor(fd, () => accept()));

// Windows: the same primitives over @ace/workspace's handle-relative add-on. Handles are Node fds,
// and every open refuses a junction or symlink the way O_NOFOLLOW does. Windows has no
// openat(".") and no readlinkat, so each handle's path is remembered; any use of that path first
// re-opens it without following links and checks it is still the handle's own file.
// Fds are closed in many places, so each path also keeps its file's identity: a reused fd
// number never inherits a closed handle's path.
export const windowsPaths = new Map<number, { path: string; file: Stats }>();
export const windowsCreate = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY;
export const windowsQuiet = (operation: () => void): boolean => {
  try {
    operation();
    return true;
  } catch {
    return false;
  }
};
export function windowsAdopt(fd: number, path: string): number {
  try {
    windowsPaths.set(fd, { path, file: statWindowsFd(fd) });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}
export const sameWindowsStats = (a: Stats, b: Stats) =>
  a.dev === b.dev && a.ino === b.ino && sameWindowsFile(a, b);
export function sameWindowsHandle(left: number, right: number): boolean {
  return sameWindowsStats(statWindowsFd(left), statWindowsFd(right));
}
/** The path remembered for `fd`, while `fd` is still the handle it was remembered for. */
export function windowsKnownPath(fd: number): string | undefined {
  const known = windowsPaths.get(fd);
  if (known === undefined) return undefined;
  const same = windowsQuiet(() => {
    if (!sameWindowsStats(known.file, statWindowsFd(fd))) throw new Error("Reused handle");
  });
  if (same) return known.path;
  windowsPaths.delete(fd);
  return undefined;
}
/** Closes a Windows command handle and forgets its path. */
export function windowsCloseQuietly(fd: number): Promise<void> {
  windowsPaths.delete(fd);
  return closeQuietly(fd);
}
/** The remembered path of a handle, confirmed to still name that same directory. */
export function windowsPath(fd: number): string {
  const path = windowsKnownPath(fd);
  if (path === undefined) throw new Error("Unknown command directory handle");
  const again = openRoot(path).fd;
  try {
    if (!sameWindowsHandle(fd, again)) throw new EntryUnavailable("Command directory moved");
  } finally {
    closeSync(again);
  }
  return path;
}
export function windowsOpenChild(directory: number, name: string): number {
  try {
    // -100 is AT_FDCWD on POSIX; on Windows the name is a drive root such as `C:\`.
    if (directory === -100) return windowsAdopt(openRoot(name).fd, name);
    const parent = windowsKnownPath(directory);
    if (parent === undefined) throw new Error("Unknown command directory handle");
    if (name === ".") {
      const again = openRoot(parent).fd;
      if (sameWindowsHandle(directory, again)) return windowsAdopt(again, parent);
      closeSync(again);
      throw new EntryUnavailable("Command directory moved");
    }
    return windowsAdopt(openAt(directory, name, constants.O_RDONLY).fd, joinPath(parent, name));
  } catch (error) {
    if (error instanceof Error && error.message === "Unknown command directory handle") throw error;
    throw new EntryUnavailable("Cannot open command entry without following links");
  }
}
export async function windowsDirectoryReader(fd: number): Promise<DirectoryReader> {
  // The reader owns `fd` from here: it closes, and forgets its path, if listing fails.
  let names: string[];
  try {
    names = descriptorNames(fd);
  } catch (error) {
    await windowsCloseQuietly(fd);
    throw error;
  }
  let closed = false;
  return {
    async read() {
      // Each entry yields to the event loop, as the POSIX reader does, so a scan never runs
      // ahead of the batch that asked for it.
      await new Promise((resolve) => setImmediate(resolve));
      return closed ? undefined : names.shift();
    },
    async close() {
      if (closed) return;
      closed = true;
      await windowsCloseQuietly(fd);
    },
  };
}
/** Whether `name` in the pinned directory is a junction or symlink (never its target). */
export function windowsIsLink(directory: number, name: string): boolean {
  const entry = openMetadataAt(directory, name).fd;
  try {
    return statWindowsFd(entry).isSymbolicLink();
  } finally {
    closeSync(entry);
  }
}
export const windowsExists = (directory: number, name: string) =>
  windowsQuiet(() => closeSync(openMetadataAt(directory, name).fd));
export function windowsReadLink(directory: number, name: string): string {
  try {
    if (!windowsIsLink(directory, name)) throw new Error("Not a link");
    const parent = windowsPath(directory);
    const text = readlinkSync(joinPath(parent, name));
    // Junctions store absolute targets; report them relative to the link's folder, as made.
    const nearby = relativePath(parent, text);
    return isAbsolute(text) && !isAbsolute(nearby) ? nearby : text;
  } catch {
    throw new EntryUnavailable("Unavailable skill link");
  }
}
export function windowsRemove(directory: number, name: string, folder: boolean): boolean {
  if (!windowsExists(directory, name)) return false;
  const link = windowsQuiet(() => {
    if (!windowsIsLink(directory, name)) throw new Error("Not a link");
  });
  // rmdir never removes a link on POSIX; unlink removes a directory junction as itself.
  if (folder) return !link && windowsQuiet(() => removeDirectoryAt(directory, name));
  if (windowsQuiet(() => unlinkAt(directory, name))) return true;
  return link && windowsQuiet(() => removeDirectoryAt(directory, name));
}
/** Rename within one pinned directory; Windows renames only inside a handle's own folder. */
export function windowsRename(
  fromDirectory: number,
  from: string,
  toDirectory: number,
  to: string,
  replace = true,
) {
  if (fromDirectory !== toDirectory && !sameWindowsHandle(fromDirectory, toDirectory)) return false;
  if (!replace) return windowsQuiet(() => renameAtNoReplace(fromDirectory, from, to));
  return windowsQuiet(() => renameAt(fromDirectory, from, to));
}
/** Drive-absolute paths only: UNC shares and device paths are refused before anything opens. */
export async function windowsOpenResolved(
  openChild: OpenCommandChild,
  path: string,
): Promise<number> {
  if (/^[\\/]{2}/.test(path))
    throw new Error(`Command roots must be on a local drive, not a share or device: ${path}`);
  if (!/^[A-Za-z]:[\\/]/.test(path)) throw new Error(`Command root isn't drive-absolute: ${path}`);
  let fd = await openChild(-100, `${path.slice(0, 2)}\\`, directoryFlags);
  try {
    const parts = path.slice(3).split(/[\\/]/).filter(Boolean);
    if (parts.length > 128) throw new Error("Trusted root depth limit");
    for (const name of parts) {
      const child = await openChild(fd, name, directoryFlags);
      await windowsCloseQuietly(fd);
      fd = child;
    }
    // Windows has no O_DIRECTORY, so the type is checked on the handle itself.
    if (!fstatSync(fd).isDirectory()) throw new EntryUnavailable("Not a command directory");
    return fd;
  } catch (error) {
    await windowsCloseQuietly(fd);
    throw error;
  }
}
/**
 * A junction to `target`, resolved against the path the pinned directory was opened at (Windows
 * symlinks need a privilege). It is made through the directory's handle like symlinkat, so a
 * folder whose path was swapped for a junction can't place it anywhere else; an existing `name`
 * fails the create itself.
 */
export function windowsJunction(target: string, directory: number, name: string): boolean {
  try {
    const parent = windowsKnownPath(directory);
    if (parent === undefined) return false;
    junctionAt(directory, name, resolvePath(parent, target));
    return true;
  } catch {
    return false;
  }
}
