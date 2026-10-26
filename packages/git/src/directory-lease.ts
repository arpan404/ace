import { createRequire } from "node:module";
import type koffiModule from "koffi";
import { z } from "zod";
import { GitError } from "./types.ts";

/**
 * Windows has no `fchdir`: a new process always opens its working directory by path. Git is
 * started in the held directory by its canonical path, read from the held object itself (so a
 * `subst` or mapped-drive alias the caller went through plays no part), while a lease keeps that
 * object in place:
 *
 * - the lease is the same object reopened by file ID, never by path, with read access and no
 *   delete sharing, so the directory and every ancestor can't be renamed or removed;
 * - the lease must be a directory, not a junction, symlink or other name-surrogate reparse point
 *   (cloud placeholders such as OneDrive folders are ordinary folders here);
 * - its `.git` entry is pinned the same way, so the directory stays nonempty and can't be turned
 *   into a junction in place (Windows refuses reparse data on a nonempty directory). A write into
 *   a folder that has no `.git` yet (`init`, a clone) creates the entry first;
 * - the canonical path must open the held object itself (same volume serial and file ID), checked
 *   before Git starts and again after it exits. A volume GUID path would avoid drive letters
 *   entirely, but Git for Windows' `sh.exe` (transports, credential helpers) hangs in one.
 *
 * Sources: CreateFileW, OpenFileById, GetFinalPathNameByHandleW, CreateDirectoryW, FILE_ID_INFO,
 * FILE_ATTRIBUTE_TAG_INFO and IsReparseTagNameSurrogate on learn.microsoft.com; MS-FSA
 * FSCTL_SET_REPARSE_POINT.
 */
export interface DirectoryLease {
  /** The held directory's canonical drive or UNC path, for the child's working directory. */
  cwd: string;
  /** Confirms the held directory is still a plain directory its path leads to; throws otherwise. */
  verify(): void;
  release(): void;
}

/** Raw Win32 surface. Handles are pointer-sized integers; -1 and 0 are invalid. */
export interface DirectoryLeaseApi {
  osHandle(fd: number): number | bigint;
  fileInfo(handle: number | bigint, infoClass: number, buffer: Buffer): boolean;
  openById(
    hint: number | bigint,
    descriptor: Buffer,
    access: number,
    share: number,
  ): number | bigint;
  /** Opens `path` itself, never following a final link. */
  openPath(path: string, access: number, share: number): number | bigint;
  /** Opens what `path` leads to, following links the way a new process's working directory does. */
  openTarget(path: string): number | bigint;
  makeDirectory(path: string): boolean;
  finalPath(handle: number | bigint, buffer: Buffer, flags: number): number;
  close(handle: number | bigint): void;
  unload(): void;
}

export interface LeaseOptions {
  /** A write may create the `.git` entry it pins when the folder has none yet. */
  createGitEntry?: boolean;
}

const FileAttributeTagInfo = 9;
const FileIdInfo = 18;
const ExtendedFileIdType = 2;
const FILE_LIST_DIRECTORY = 0x1;
const FILE_READ_ATTRIBUTES = 0x80;
const SYNCHRONIZE = 0x100000;
const FILE_SHARE_READ_WRITE = 0x3;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const NAME_SURROGATE = 0x20000000;
const VOLUME_NAME_DOS = 0x0;
const leaseAccess = FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
const pathCharacters = 32_768;

function invalid(handle: number | bigint): boolean {
  return handle === -1 || handle === -1n || handle === 0 || handle === 0n;
}

function changed(reason: string): GitError {
  return new GitError("filesystem_error", `The project folder changed: ${reason}`);
}

function unsupported(): GitError {
  return new GitError(
    "unsupported_repository",
    "Git can't run in this network folder on Windows: it can't be held in place. Use a local folder.",
  );
}

// koffi loads lazily and only on Windows. uv_get_osfhandle comes from the running executable
// (node.exe, or electron.exe as Node), so the descriptor table is the one the daemon's fd is in.
function loadDirectoryLeaseApi(): DirectoryLeaseApi {
  const koffi: typeof koffiModule = createRequire(import.meta.url)("koffi");
  const node = koffi.load(process.execPath);
  const kernel = koffi.load("kernel32.dll");
  try {
    const osHandle = node.func("intptr_t uv_get_osfhandle(int fd)");
    const info = kernel.func(
      "int __stdcall GetFileInformationByHandleEx(intptr_t file, int infoClass, _Out_ void* info, uint32 size)",
    );
    const byId = kernel.func(
      "intptr_t __stdcall OpenFileById(intptr_t hint, void* id, uint32 access, uint32 share, void* security, uint32 flags)",
    );
    const byPath = kernel.func(
      "intptr_t __stdcall CreateFileW(str16 path, uint32 access, uint32 share, void* security, uint32 disposition, uint32 flags, intptr_t template)",
    );
    const mkdir = kernel.func("int __stdcall CreateDirectoryW(str16 path, void* security)");
    const final = kernel.func(
      "uint32 __stdcall GetFinalPathNameByHandleW(intptr_t file, _Out_ void* path, uint32 characters, uint32 flags)",
    );
    const close = kernel.func("int __stdcall CloseHandle(intptr_t handle)");
    // FILE_FLAG_BACKUP_SEMANTICS opens directories; FILE_FLAG_OPEN_REPARSE_POINT never follows.
    const backup = 0x02000000;
    const flags = backup | 0x00200000;
    const integer = z.number().int();
    return {
      osHandle: (fd) => osHandle(fd),
      fileInfo: (handle, infoClass, buffer) =>
        integer.parse(info(handle, infoClass, buffer, buffer.length)) !== 0,
      openById: (hint, descriptor, access, share) =>
        byId(hint, descriptor, access, share, null, flags),
      // OPEN_EXISTING
      openPath: (path, access, share) => byPath(path, access, share, null, 3, flags, 0),
      // Attributes only, sharing everything: an observer that blocks nothing.
      openTarget: (path) => byPath(path, FILE_READ_ATTRIBUTES, 0x7, null, 3, backup, 0),
      makeDirectory: (path) => integer.parse(mkdir(path, null)) !== 0,
      finalPath: (handle, buffer, pathFlags) =>
        integer.parse(final(handle, buffer, buffer.length / 2, pathFlags)),
      close: (handle) => {
        close(handle);
      },
      unload: () => {
        kernel.unload();
        node.unload();
      },
    };
  } catch (error) {
    kernel.unload();
    node.unload();
    throw error;
  }
}

/** FILE_ID_INFO: the 8-byte volume serial number, then the 16-byte file ID. */
function identity(api: DirectoryLeaseApi, handle: number | bigint): Buffer | undefined {
  const info = Buffer.alloc(24);
  return api.fileInfo(handle, FileIdInfo, info) ? info : undefined;
}

function plainDirectory(api: DirectoryLeaseApi, handle: number | bigint): void {
  // FILE_ATTRIBUTE_TAG_INFO: attributes, then the reparse tag.
  const tag = Buffer.alloc(8);
  if (!api.fileInfo(handle, FileAttributeTagInfo, tag)) throw changed("it is unreadable");
  const attributes = tag.readUInt32LE(0);
  if ((attributes & FILE_ATTRIBUTE_DIRECTORY) === 0) throw changed("it is not a folder");
  // Junctions and symlinks name another place; cloud and dedup tags keep the folder itself.
  if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0 && tag.readUInt32LE(4) & NAME_SURROGATE)
    throw changed("it is now a link");
}

function finalPath(api: DirectoryLeaseApi, handle: number | bigint): string {
  const buffer = Buffer.alloc(pathCharacters * 2);
  const length = api.finalPath(handle, buffer, VOLUME_NAME_DOS);
  // Zero is failure; a length at or past the buffer is the size it would need.
  if (length <= 0 || length >= pathCharacters) throw changed("it has no path");
  return buffer.toString("utf16le", 0, length * 2);
}

/** The canonical drive (`C:\\...`) or UNC (`\\\\server\\share\\...`) path of the held object. */
function workingPath(api: DirectoryLeaseApi, handle: number | bigint): string {
  const path = finalPath(api, handle);
  if (/^\\\\\?\\[A-Za-z]:\\/.test(path)) return path.slice(4);
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  throw changed("it has no drive path");
}

/** `path`, followed as a new process would, must open the object `expected` identifies. */
function leadsTo(api: DirectoryLeaseApi, path: string, expected: Buffer): void {
  const target = api.openTarget(path);
  if (invalid(target)) throw changed("its path no longer opens it");
  try {
    if (!identity(api, target)?.equals(expected)) throw changed("its path leads elsewhere");
  } finally {
    api.close(target);
  }
}

/** Pins `<cwd>\.git`, creating it first when allowed and absent; it must be this folder's own. */
function pinGitEntry(
  api: DirectoryLeaseApi,
  cwd: string,
  create: boolean,
): number | bigint | undefined {
  const name = `${cwd}\\.git`;
  let entry = api.openPath(name, leaseAccess, FILE_SHARE_READ_WRITE);
  if (invalid(entry) && create) {
    api.makeDirectory(name);
    entry = api.openPath(name, leaseAccess, FILE_SHARE_READ_WRITE);
    if (invalid(entry)) throw changed("its .git entry could not be created");
  }
  if (invalid(entry)) return undefined;
  // Opened by path: it must still be this directory's own entry, not one behind a new link.
  let pinned: string;
  try {
    pinned = workingPath(api, entry);
  } catch (error) {
    api.close(entry);
    throw error;
  }
  if (pinned.toUpperCase() !== name.toUpperCase()) {
    api.close(entry);
    throw changed("it moved");
  }
  return entry;
}

/** Leases the directory behind a held descriptor for one Git process. */
export function leaseHeldDirectory(
  fd: number,
  options: LeaseOptions = {},
  load: () => DirectoryLeaseApi = loadDirectoryLeaseApi,
): DirectoryLease {
  const api = load();
  const handles: (number | bigint)[] = [];
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const handle of handles.splice(0)) api.close(handle);
    api.unload();
  };
  try {
    const held = api.osHandle(z.number().int().nonnegative().parse(fd));
    if (invalid(held)) throw changed("its descriptor is closed");
    const network = workingPath(api, held).startsWith("\\\\");
    const expected = identity(api, held);
    if (!expected) throw network ? unsupported() : changed("its identity is unreadable");
    // FILE_ID_DESCRIPTOR: size, type, then the 16-byte extended file ID.
    const descriptor = Buffer.alloc(24);
    descriptor.writeUInt32LE(descriptor.length, 0);
    descriptor.writeUInt32LE(ExtendedFileIdType, 4);
    expected.copy(descriptor, 8, 8, 24);
    const lease = api.openById(held, descriptor, leaseAccess, FILE_SHARE_READ_WRITE);
    if (invalid(lease)) throw network ? unsupported() : changed("it is being renamed or deleted");
    handles.push(lease);
    if (!identity(api, lease)?.equals(expected)) throw changed("it was replaced");
    plainDirectory(api, lease);
    const cwd = workingPath(api, lease);
    const entry = pinGitEntry(api, cwd, options.createGitEntry === true);
    if (entry !== undefined) handles.push(entry);
    plainDirectory(api, lease);
    leadsTo(api, cwd, expected);
    return {
      cwd,
      verify: () => {
        if (released) throw changed("its lease ended");
        plainDirectory(api, lease);
        leadsTo(api, cwd, expected);
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
