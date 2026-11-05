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
import {
  closeCommandFd,
  commandLane,
  commandRootSettled,
  posix,
  posixInteger,
  posixOpen,
  rootOf,
  type CommandCalls,
} from "./posix-calls.ts";
import { directoryFlags } from "./posix-flags.ts";
export {
  closeCommandFd,
  commandCallOwner,
  commandRootSettled,
  useCommandCallDeadline,
  type CommandCalls,
} from "./posix-calls.ts";
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
export class EntryUnavailable extends Error {}
export { directoryFlags, fileFlags } from "./posix-flags.ts";
export const openCommandChild: OpenCommandChild = async (directory, name, flags, owner) => {
  if (process.platform === "win32") return windowsOpenChild(directory, name);
  const root = rootOf(directory, owner);
  const handle = await posixOpen(
    root,
    (result) => ({ op: "open", directory, name, flags, handle: result }),
    owner,
  );
  if (handle < 0)
    throw new EntryUnavailable("Cannot open command entry without following symlinks");
  return handle;
};
/**
 * An absolute directory path opened from `/` in one call on `root`'s thread, with O_NOFOLLOW at
 * every component: a component swapped for a symlink fails closed.
 */
export async function openCommandPath(
  root: string,
  path: string,
  owner?: CommandCalls,
): Promise<number> {
  if (process.platform === "win32") return windowsOpenResolved(openCommandChild, path);
  const handle = await posixOpen(
    root,
    (result) => ({ op: "openPath", path, handle: result }),
    owner,
  );
  if (handle < 0) throw new EntryUnavailable("Cannot open command folder without following links");
  return handle;
}
/** Real entries (never `.` or `..`) a directory listing reads at most: discovery's limit. */
export const listingLimit = 2048;
/** A listing had more entries than its limit; its reader has given every name it read. */
export class DirectoryListingTruncated extends Error {}
const entryName = z
  .string()
  .min(1)
  .max(1024)
  .refine((name) => !name.includes("/") && !name.includes("\0"));
const Listing = z.object({ names: z.array(entryName), truncated: z.boolean() });
/**
 * Takes `fd` over in every case and lists up to `limit` real entries in one call on its thread,
 * which closes the directory before answering, so no handle outlives the call. The reader gives
 * the names from memory, then throws `DirectoryListingTruncated` if more were left.
 */
export async function directoryReader(
  fd: number,
  owner?: CommandCalls,
  limit = listingLimit,
): Promise<DirectoryReader> {
  if (process.platform === "win32") return windowsDirectoryReader(fd);
  const value = await posix({ op: "listDirectory", fd, limit }, fd, owner);
  if (value === null) throw new Error("Cannot enumerate command directory");
  const listing = Listing.parse(value);
  return memoryReader(listing.names, listing.truncated);
}
function memoryReader(names: string[], truncated: boolean): DirectoryReader {
  let next = 0;
  return {
    async read() {
      // Each entry yields to the event loop, so a scan never runs ahead of the batch that asked.
      await new Promise((resolve) => setImmediate(resolve));
      if (next < names.length) return names[next++];
      if (truncated) throw new DirectoryListingTruncated("Directory entry limit exceeded");
      return undefined;
    },
    async close() {
      next = names.length;
      truncated = false;
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
  const root = rootOf(directory, owner);
  const handle = await posixOpen(
    root,
    (result) => ({ op: "create", directory, name, flags, handle: result }),
    owner,
  );
  if (handle < 0) throw new EntryUnavailable("Cannot create prompt file");
  return handle;
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
/**
 * Removes `name` from the directory at `path` in the background, once nothing abandoned under
 * `root` can still land: a change left running there (a cancelled or timed-out save) finishes
 * first, so the file it may still create or rename is the one removed. The folder is reopened by
 * path, never followed through a link, since the handles of an abandoned thread are gone.
 */
export function removeCommandEntryLater(root: string, path: string, name: string): void {
  void (async () => {
    await commandRootSettled(root);
    const parent = await openCommandPath(root, path);
    try {
      await removeCommandEntry(parent, name, false);
    } finally {
      await closeCommandFd(parent);
    }
  })().catch(() => {});
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
  lane = commandLane(path),
): Promise<number> {
  if (process.platform === "win32") return windowsOpenResolved(openChild, path);
  // `/` opens on the lane's own thread; everything opened beneath it stays there.
  let fd = await posixOpen(
    lane,
    (handle) => ({ op: "open", directory: -100, name: "/", flags: directoryFlags, handle }),
    owner,
  );
  if (fd < 0) throw new EntryUnavailable("Cannot open /");
  try {
    const parts = path.split("/").filter(Boolean);
    if (parts.length > 128) throw new Error("Trusted root depth limit");
    for (const name of parts) {
      const child = await openChild(fd, name, directoryFlags, owner);
      await closeCommandFd(fd);
      fd = child;
    }
    return fd;
  } catch (error) {
    await closeCommandFd(fd);
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
async function windowsDirectoryReader(fd: number): Promise<DirectoryReader> {
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
