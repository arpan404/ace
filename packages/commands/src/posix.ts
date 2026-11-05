import { z } from "zod";
import { close as closeDescriptor, constants } from "node:fs";
import { closeSync, fstatSync, readlinkSync } from "node:fs";
import {
  isAbsolute,
  join as joinPath,
  relative as relativePath,
  resolve as resolvePath,
} from "node:path";
import {
  descriptorNames,
  mkdirAt,
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
import type { Stats } from "node:fs";
import { CommandFilesystemUnavailable, PosixCallOwner, type PosixLanes } from "./posix-lanes.ts";
import type { PosixValue } from "./posix-lanes.ts";
import { posixWorkerLanes } from "./posix-worker-client.ts";
import type { PosixOperation } from "./posix-wire.ts";
/** Runs calls for whoever is asking; an owner's calls stop when it is cancelled. */
export interface CommandCalls {
  run(
    root: string,
    operation: PosixOperation,
    options?: { executor?: number },
  ): Promise<{ value: PosixValue; executor: number }>;
  /** The same lanes without cancellation, for releasing what these calls opened. */
  cleanup(): CommandCalls;
}
export type OpenCommandChild = (
  directory: number,
  name: string,
  flags: number,
  owner?: CommandCalls,
) => Promise<number>;
export interface DirectoryReader {
  read(): Promise<string | undefined>;
  close(): Promise<void>;
}
const integer = z.number().int();
export class EntryUnavailable extends Error {}
// Every POSIX call runs on a worker thread of the root its descriptor was opened under: a stalled
// network, FUSE or cloud mount blocks that root's thread, never the daemon's event loop or
// another root. Descriptors opened outside a resolved root share one lane.
let lanes: PosixLanes | undefined;
const descriptorRoots = new Map<number, string>();
const sharedRoot = "";
const rootOf = (fd: number) => descriptorRoots.get(fd) ?? sharedRoot;
const commandLanes = () => (lanes ??= posixWorkerLanes());
async function posix(
  operation: PosixOperation,
  fd: number,
  owner?: CommandCalls,
): Promise<PosixValue> {
  return (await (owner ?? commandLanes()).run(rootOf(fd), operation)).value;
}
async function posixInteger(
  operation: PosixOperation,
  fd: number,
  owner?: CommandCalls,
): Promise<number> {
  return integer.parse(await posix(operation, fd, owner));
}
/** Opens a descriptor under `parent`'s root; the new descriptor stays on that root. */
async function posixOpen(
  operation: PosixOperation,
  parent: number,
  owner?: CommandCalls,
): Promise<number> {
  const fd = await posixInteger(operation, parent, owner);
  if (fd >= 0) descriptorRoots.set(fd, rootOf(parent));
  return fd;
}
/** A new owner for one user's calls, cancelled together. */
export function commandCallOwner(): PosixCallOwner {
  return new PosixCallOwner(commandLanes());
}
/** Tests only: later calls use lanes with a short deadline. Returns the restore. */
export function useCommandCallDeadline(
  deadlineMs: number,
  limits: { maxWorkers?: number; maxThreads?: number } = {},
): () => void {
  const previous = lanes;
  lanes = posixWorkerLanes(deadlineMs, limits);
  return () => {
    lanes = previous;
  };
}
const closeOnExec = process.platform === "darwin" ? 0x1000000 : 0x80000;
export const directoryFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | closeOnExec;
export const fileFlags =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec;
export const openCommandChild: OpenCommandChild = async (directory, name, flags, owner) => {
  if (process.platform === "win32") return windowsOpenChild(directory, name);
  const fd = await posixOpen({ op: "open", directory, name, flags }, directory, owner);
  if (fd < 0) throw new EntryUnavailable("Cannot open command entry without following symlinks");
  return fd;
};
export async function directoryReader(fd: number, owner?: CommandCalls): Promise<DirectoryReader> {
  if (process.platform === "win32") return windowsDirectoryReader(fd);
  // The stream lives in the worker that opened it; it dies with that worker, and its fd with it.
  const root = rootOf(fd);
  const opened = await (owner ?? commandLanes()).run(root, { op: "openDirectory", fd });
  const reader = integer.parse(opened.value);
  if (reader === 0) throw new Error("Cannot enumerate command directory");
  // Reads stop with their owner; the close never does, so a cancelled owner can't strand a stream.
  const calls = owner ?? commandLanes();
  const stream = (operation: PosixOperation, through = calls) =>
    through.run(root, operation, { executor: opened.executor });
  let closed = false;
  return {
    async read() {
      if (closed) return undefined;
      const { value } = await stream({ op: "readDirectory", reader });
      if (value === null) return undefined;
      return z
        .string()
        .min(1)
        .max(1024)
        .refine((name) => !name.includes("/") && !name.includes("\0"))
        .parse(value);
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        integer.parse((await stream({ op: "closeDirectory", reader }, calls.cleanup())).value);
      } catch (error) {
        // An abandoned worker keeps the stream; closing it from here could race its stuck call.
        if (!(error instanceof CommandFilesystemUnavailable)) throw error;
      }
    },
  };
}

/** Small descriptor-relative mutation primitives, shared by prompt file editing. */
export async function createCommandDirectory(
  directory: number,
  name: string,
  owner?: CommandCalls,
): Promise<void> {
  if (process.platform === "win32") return void windowsQuiet(() => mkdirAt(directory, name));
  await posix({ op: "mkdir", directory, name, mode: 0o700 }, directory, owner);
  // The caller opens the result with O_NOFOLLOW, including when mkdir found an existing entry.
}
export async function createCommandFile(
  directory: number,
  name: string,
  owner?: CommandCalls,
): Promise<number> {
  if (process.platform === "win32") {
    const parent = windowsKnownPath(directory) ?? "";
    try {
      return windowsAdopt(openAt(directory, name, windowsCreate).fd, joinPath(parent, name));
    } catch {
      throw new EntryUnavailable("Cannot create prompt file");
    }
  }
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  const fd = await posixOpen({ op: "create", directory, name, flags }, directory, owner);
  if (fd < 0) throw new EntryUnavailable("Cannot create prompt file");
  return fd;
}
export async function replaceCommandFile(
  directory: number,
  source: string,
  target: string,
  owner?: CommandCalls,
): Promise<void> {
  if (process.platform === "win32") {
    if (!windowsQuiet(() => renameAt(directory, source, target)))
      throw new Error("Cannot replace prompt file");
    return;
  }
  const renamed = await posixInteger(
    { op: "rename", from: directory, fromName: source, to: directory, toName: target, flags: 0 },
    directory,
    owner,
  );
  if (renamed < 0) throw new Error("Cannot replace prompt file");
}
export async function removeCommandFile(
  directory: number,
  name: string,
  owner?: CommandCalls,
): Promise<void> {
  if (process.platform === "win32") return void windowsQuiet(() => unlinkAt(directory, name));
  await posix({ op: "unlink", directory, name, flags: 0 }, directory, owner);
}
export async function linkCommandFile(
  directory: number,
  source: string,
  target: string,
  owner?: CommandCalls,
): Promise<void> {
  if (process.platform === "win32") {
    // No hard links: claim the name exclusively, then replace the claim with the written file.
    if (!windowsQuiet(() => closeSync(openAt(directory, target, windowsCreate).fd)))
      throw new Error("prompt_conflict");
    if (!windowsQuiet(() => renameAt(directory, source, target))) {
      windowsQuiet(() => unlinkAt(directory, target));
      throw new Error("prompt_conflict");
    }
    return;
  }
  const linked = await posixInteger(
    { op: "link", from: directory, fromName: source, to: directory, toName: target, flags: 0 },
    directory,
    owner,
  );
  if (linked < 0) throw new Error("prompt_conflict");
}

/** Read the link itself relative to the pinned skill directory, never its target. */
export async function readCommandLink(
  directory: number,
  name: string,
  owner?: CommandCalls,
): Promise<string> {
  if (process.platform === "win32") return windowsReadLink(directory, name);
  const text = await posix({ op: "readLink", directory, name }, directory, owner);
  if (typeof text !== "string") throw new EntryUnavailable("Unavailable skill link");
  return text;
}

// unlinkat's AT_REMOVEDIR, from <fcntl.h>.
const removeDirectoryFlag = process.platform === "darwin" ? 0x80 : 0x200;
/** mkdirat; false when the entry already exists or can't be made. */
export async function makeCommandDirectory(
  directory: number,
  name: string,
  mode: number,
): Promise<boolean> {
  if (process.platform === "win32") return windowsQuiet(() => mkdirAt(directory, name));
  return (await posixInteger({ op: "mkdir", directory, name, mode }, directory)) === 0;
}
/** unlinkat of a file, symlink (never its target) or, with `folder`, an empty directory. */
export async function removeCommandEntry(
  directory: number,
  name: string,
  folder: boolean,
): Promise<boolean> {
  if (process.platform === "win32") return windowsRemove(directory, name, folder);
  const flags = folder ? removeDirectoryFlag : 0;
  return (await posixInteger({ op: "unlink", directory, name, flags }, directory)) === 0;
}
/** renameat between two pinned directories; neither name is followed. */
export async function renameCommandEntry(
  fromDirectory: number,
  from: string,
  toDirectory: number,
  to: string,
): Promise<boolean> {
  if (process.platform === "win32") return windowsRename(fromDirectory, from, toDirectory, to);
  const operation = { from: fromDirectory, fromName: from, to: toDirectory, toName: to };
  return (await posixInteger({ op: "rename", ...operation, flags: 0 }, fromDirectory)) === 0;
}
const closeQuietly = (fd: number) =>
  new Promise<void>((accept) => closeDescriptor(fd, () => accept()));
/**
 * Open an absolute, already-resolved directory path one component at a time from `/`, with
 * O_NOFOLLOW at every step: a component swapped for a symlink fails closed.
 */
export async function openResolvedDirectory(
  openChild: OpenCommandChild,
  path: string,
  owner?: CommandCalls,
): Promise<number> {
  if (process.platform === "win32") return windowsOpenResolved(openChild, path);
  let fd = await openChild(-100, "/", directoryFlags, owner);
  // Everything opened beneath this root runs on the root's own worker.
  descriptorRoots.set(fd, path);
  try {
    const parts = path.split("/").filter(Boolean);
    if (parts.length > 128) throw new Error("Trusted root depth limit");
    for (const name of parts) {
      const child = await openChild(fd, name, directoryFlags, owner);
      await closeQuietly(fd);
      fd = child;
    }
    return fd;
  } catch (error) {
    await closeQuietly(fd);
    throw error;
  }
}

// RENAME_EXCL / RENAME_SWAP (<stdio.h>, macOS) and RENAME_NOREPLACE / RENAME_EXCHANGE (Linux).
const renameModes =
  process.platform === "darwin" ? { noReplace: 0x4, exchange: 0x2 } : { noReplace: 1, exchange: 2 };
/**
 * `noReplace` moves `from` to `to` only while `to` doesn't exist (plain renameat would replace an
 * empty directory); `exchange` swaps the two entries atomically. Neither name is followed.
 */
export async function renameCommandEntryAs(
  mode: keyof typeof renameModes,
  fromDirectory: number,
  from: string,
  toDirectory: number,
  to: string,
): Promise<boolean> {
  if (process.platform === "win32") {
    // The add-on refuses an existing `to` in the same rename call, with no separate check.
    if (mode === "exchange") return false;
    return windowsRename(fromDirectory, from, toDirectory, to, false);
  }
  const flags = renameModes[mode];
  const operation = { from: fromDirectory, fromName: from, to: toDirectory, toName: to };
  return (await posixInteger({ op: "renameFlags", ...operation, flags }, fromDirectory)) === 0;
}
/** symlinkat: `name` in the pinned directory, storing `target` as text; fails if `name` exists. */
export async function linkCommandEntry(
  target: string,
  directory: number,
  name: string,
): Promise<boolean> {
  if (process.platform === "win32") return windowsJunction(target, directory, name);
  return (await posixInteger({ op: "symlink", target, directory, name }, directory)) === 0;
}

// Windows: the same primitives over @ace/workspace's handle-relative add-on. Handles are Node fds,
// and every open refuses a junction or symlink the way O_NOFOLLOW does. Windows has no
// openat(".") and no readlinkat, so each handle's path is remembered; any use of that path first
// re-opens it without following links and checks it is still the handle's own file.
// Fds are closed in many places, so each path also keeps its file's identity: a reused fd
// number never inherits a closed handle's path.
const windowsPaths = new Map<number, { path: string; file: Stats }>();
const windowsCreate = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY;
const windowsQuiet = (operation: () => void): boolean => {
  try {
    operation();
    return true;
  } catch {
    return false;
  }
};
function windowsAdopt(fd: number, path: string): number {
  try {
    windowsPaths.set(fd, { path, file: statWindowsFd(fd) });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}
const sameWindowsStats = (a: Stats, b: Stats) =>
  a.dev === b.dev && a.ino === b.ino && sameWindowsFile(a, b);
function sameWindowsHandle(left: number, right: number): boolean {
  return sameWindowsStats(statWindowsFd(left), statWindowsFd(right));
}
/** The path remembered for `fd`, while `fd` is still the handle it was remembered for. */
function windowsKnownPath(fd: number): string | undefined {
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
function windowsCloseQuietly(fd: number): Promise<void> {
  windowsPaths.delete(fd);
  return closeQuietly(fd);
}
/** The remembered path of a handle, confirmed to still name that same directory. */
function windowsPath(fd: number): string {
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
function windowsOpenChild(directory: number, name: string): number {
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
function windowsDirectoryReader(fd: number): DirectoryReader {
  const names = descriptorNames(fd);
  let closed = false;
  return {
    async read() {
      // Each entry yields to the event loop, as the POSIX reader's threaded readdir does, so a
      // scan never runs ahead of the batch that asked for it.
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
function windowsIsLink(directory: number, name: string): boolean {
  const entry = openMetadataAt(directory, name).fd;
  try {
    return statWindowsFd(entry).isSymbolicLink();
  } finally {
    closeSync(entry);
  }
}
const windowsExists = (directory: number, name: string) =>
  windowsQuiet(() => closeSync(openMetadataAt(directory, name).fd));
/**
 * Windows: whether anything, link or not, is called `name` in the pinned directory, asked through
 * the handle. Link reads need the folder's path, which fails once the folder has moved.
 */
export async function commandEntryExists(directory: number, name: string): Promise<boolean> {
  if (process.platform !== "win32") throw new Error("Only Windows asks through the handle");
  return windowsExists(directory, name);
}
/** Windows: whether `name` in the pinned directory is a link, asked through the handle alone. */
export async function commandEntryIsLink(directory: number, name: string): Promise<boolean> {
  if (process.platform !== "win32") throw new Error("Only Windows asks through the handle");
  try {
    return windowsIsLink(directory, name);
  } catch {
    return false;
  }
}
function windowsReadLink(directory: number, name: string): string {
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
function windowsRemove(directory: number, name: string, folder: boolean): boolean {
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
function windowsRename(
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
/**
 * Windows has no atomic exchange: `first` and `second` swap through `free`, a name that must not
 * exist, in three no-replace moves. A crash between them leaves each folder at one of the three
 * names, which is why callers pass a name their journal already records.
 */
export async function exchangeCommandEntriesThrough(
  directory: number,
  first: string,
  second: string,
  free: string,
): Promise<boolean> {
  if (process.platform !== "win32") throw new Error("Only Windows swaps through a free name");
  return (
    (await renameCommandEntryAs("noReplace", directory, second, directory, free)) &&
    (await renameCommandEntryAs("noReplace", directory, first, directory, second)) &&
    (await renameCommandEntryAs("noReplace", directory, free, directory, first))
  );
}
/** Drive-absolute paths only: UNC shares and device paths are refused before anything opens. */
async function windowsOpenResolved(openChild: OpenCommandChild, path: string): Promise<number> {
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
function windowsJunction(target: string, directory: number, name: string): boolean {
  try {
    const parent = windowsKnownPath(directory);
    if (parent === undefined) return false;
    junctionAt(directory, name, resolvePath(parent, target));
    return true;
  } catch {
    return false;
  }
}
