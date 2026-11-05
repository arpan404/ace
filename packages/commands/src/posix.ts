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
import { cString, openLibrary, readCString, type NativeFunction } from "@ace/provider-kit/bun-ffi";
export type OpenCommandChild = (directory: number, name: string, flags: number) => Promise<number>;
export interface DirectoryReader {
  read(): Promise<string | undefined>;
  close(): Promise<void>;
}
const integer = z.number().int();
const pointer = z.number().nullable();
export class EntryUnavailable extends Error {}
// OS interface declarations only. No provider or third-party implementation code.
function bindings() {
  if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch))
    throw new Error("Secure command discovery requires 64-bit macOS or Linux");
  const darwin = process.platform === "darwin";
  const suffix = darwin && process.arch === "x64" ? "$INODE64" : "";
  // renameatx_np (macOS) and renameat2 (Linux) take the same arguments; only flag values differ.
  const renameFlags = darwin ? "renameatx_np" : "renameat2";
  const library = openLibrary(darwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    openat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    readlinkat: { args: ["i32", "ptr", "ptr", "u64"], returns: "i64_fast" },
    mkdirat: { args: ["i32", "ptr", "u32"], returns: "i32" },
    renameat: { args: ["i32", "ptr", "i32", "ptr"], returns: "i32" },
    unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    linkat: { args: ["i32", "ptr", "i32", "ptr", "i32"], returns: "i32" },
    symlinkat: { args: ["ptr", "i32", "ptr"], returns: "i32" },
    [renameFlags]: { args: ["i32", "ptr", "i32", "ptr", "u32"], returns: "i32" },
    [`fdopendir${suffix}`]: { args: ["i32"], returns: "ptr" },
    [`readdir${suffix}`]: { args: ["ptr"], returns: "ptr" },
    closedir: { args: ["ptr"], returns: "i32" },
  });
  const c = library.symbols;
  const bound = (name: string): NativeFunction => {
    const fn = c[name];
    if (!fn) throw new Error(`Missing native function ${name}`);
    return fn;
  };
  const openat = bound("openat");
  const readlinkat = bound("readlinkat");
  const mkdirat = bound("mkdirat");
  const renameat = bound("renameat");
  const unlinkat = bound("unlinkat");
  const linkat = bound("linkat");
  const symlinkat = bound("symlinkat");
  const closedir = bound("closedir");
  const renameWithFlags = bound(renameFlags);
  const fdopendir = bound(`fdopendir${suffix}`);
  const readdir = bound(`readdir${suffix}`);
  return {
    // Without O_CREAT, openat reads no mode, so its variadic tail is never passed.
    open: (directory: number, name: string, flags: number) =>
      openat(directory, cString(name), flags),
    readlink: (directory: number, name: string, buffer: Buffer, size: number) =>
      readlinkat(directory, cString(name), buffer, size),
    mkdir: (directory: number, name: string, mode: number) =>
      mkdirat(directory, cString(name), mode),
    rename: (olddir: number, oldname: string, newdir: number, newname: string) =>
      renameat(olddir, cString(oldname), newdir, cString(newname)),
    unlink: (directory: number, name: string, flags: number) =>
      unlinkat(directory, cString(name), flags),
    link: (olddir: number, oldname: string, newdir: number, newname: string, flags: number) =>
      linkat(olddir, cString(oldname), newdir, cString(newname), flags),
    symlink: (target: string, directory: number, name: string) =>
      symlinkat(cString(target), directory, cString(name)),
    renameFlags: (
      olddir: number,
      oldname: string,
      newdir: number,
      newname: string,
      flags: number,
    ) => renameWithFlags(olddir, cString(oldname), newdir, cString(newname), flags),
    directory: (fd: number) => fdopendir(fd),
    next: (directory: number) => readdir(directory),
    close: (directory: number) => closedir(directory),
  };
}
let native: ReturnType<typeof bindings> | undefined;
function api() {
  return (native ??= bindings());
}
const closeOnExec = process.platform === "darwin" ? 0x1000000 : 0x80000;
export const directoryFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | closeOnExec;
export const fileFlags =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec;
export const openCommandChild: OpenCommandChild = async (directory, name, flags) => {
  if (process.platform === "win32") return windowsOpenChild(directory, name);
  const fd = integer.parse(api().open(directory, name, flags));
  if (fd < 0) throw new EntryUnavailable("Cannot open command entry without following symlinks");
  return fd;
};
export async function directoryReader(fd: number): Promise<DirectoryReader> {
  if (process.platform === "win32") return windowsDirectoryReader(fd);
  const handle = pointer.parse(api().directory(fd));
  if (handle === null) throw new Error("Cannot enumerate command directory");
  let closed = false;
  return {
    async read() {
      if (closed) return undefined;
      const entry = pointer.parse(api().next(handle));
      if (entry === null) return undefined;
      // Public dirent ABIs: Linux 64-bit d_name at 19; Darwin inode64 at 21.
      const offset = process.platform === "darwin" ? 21 : 19;
      const value = readCString(entry, offset);
      return z
        .string()
        .min(1)
        .max(1024)
        .refine((name) => !name.includes("/") && !name.includes("\0"))
        .parse(value);
    },
    async close() {
      if (!closed) {
        closed = true;
        integer.parse(api().close(handle));
      }
    },
  };
}

/** Small descriptor-relative mutation primitives, shared by prompt file editing. */
export async function createCommandDirectory(directory: number, name: string): Promise<void> {
  if (process.platform === "win32") return void windowsQuiet(() => mkdirAt(directory, name));
  api().mkdir(directory, name, 0o700);
  // The caller opens the result with O_NOFOLLOW, including when mkdir found an existing entry.
}
export async function createCommandFile(directory: number, name: string): Promise<number> {
  if (process.platform === "win32") {
    const parent = windowsKnownPath(directory) ?? "";
    try {
      return windowsAdopt(openAt(directory, name, windowsCreate).fd, joinPath(parent, name));
    } catch {
      throw new EntryUnavailable("Cannot create prompt file");
    }
  }
  // openat with O_CREAT takes its mode as a variadic argument, which bun:ffi cannot pass (and
  // Apple's arm64 ABI passes on the stack). @ace/workspace's add-on creates it with mode 0600.
  try {
    return openAt(directory, name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL).fd;
  } catch {
    throw new EntryUnavailable("Cannot create prompt file");
  }
}
export async function replaceCommandFile(
  directory: number,
  source: string,
  target: string,
): Promise<void> {
  if (process.platform === "win32") {
    if (!windowsQuiet(() => renameAt(directory, source, target)))
      throw new Error("Cannot replace prompt file");
    return;
  }
  if (integer.parse(api().rename(directory, source, directory, target)) < 0)
    throw new Error("Cannot replace prompt file");
}
export async function removeCommandFile(directory: number, name: string): Promise<void> {
  if (process.platform === "win32") return void windowsQuiet(() => unlinkAt(directory, name));
  api().unlink(directory, name, 0);
}
export async function linkCommandFile(
  directory: number,
  source: string,
  target: string,
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
  if (integer.parse(api().link(directory, source, directory, target, 0)) < 0)
    throw new Error("prompt_conflict");
}

/** Read the link itself relative to the pinned skill directory, never its target. */
export async function readCommandLink(directory: number, name: string): Promise<string> {
  if (process.platform === "win32") return windowsReadLink(directory, name);
  const bytes = Buffer.alloc(4096);
  const count = integer.parse(api().readlink(directory, name, bytes, bytes.length));
  if (count < 1 || count >= bytes.length) throw new EntryUnavailable("Unavailable skill link");
  return bytes.subarray(0, count).toString("utf8");
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
  return integer.parse(api().mkdir(directory, name, mode)) === 0;
}
/** unlinkat of a file, symlink (never its target) or, with `folder`, an empty directory. */
export async function removeCommandEntry(
  directory: number,
  name: string,
  folder: boolean,
): Promise<boolean> {
  if (process.platform === "win32") return windowsRemove(directory, name, folder);
  return integer.parse(api().unlink(directory, name, folder ? removeDirectoryFlag : 0)) === 0;
}
/** renameat between two pinned directories; neither name is followed. */
export async function renameCommandEntry(
  fromDirectory: number,
  from: string,
  toDirectory: number,
  to: string,
): Promise<boolean> {
  if (process.platform === "win32") return windowsRename(fromDirectory, from, toDirectory, to);
  return integer.parse(api().rename(fromDirectory, from, toDirectory, to)) === 0;
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
): Promise<number> {
  if (process.platform === "win32") return windowsOpenResolved(openChild, path);
  let fd = await openChild(-100, "/", directoryFlags);
  try {
    const parts = path.split("/").filter(Boolean);
    if (parts.length > 128) throw new Error("Trusted root depth limit");
    for (const name of parts) {
      const child = await openChild(fd, name, directoryFlags);
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
  return integer.parse(api().renameFlags(fromDirectory, from, toDirectory, to, flags)) === 0;
}
/** symlinkat: `name` in the pinned directory, storing `target` as text; fails if `name` exists. */
export async function linkCommandEntry(
  target: string,
  directory: number,
  name: string,
): Promise<boolean> {
  if (process.platform === "win32") return windowsJunction(target, directory, name);
  return integer.parse(api().symlink(target, directory, name)) === 0;
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
