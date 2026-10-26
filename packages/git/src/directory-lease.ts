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
 * - the lease must be a directory, not a junction or other reparse point;
 * - an existing `.git` entry is pinned the same way, so the directory stays nonempty and can't be
 *   turned into a junction in place (Windows refuses reparse data on a nonempty directory).
 *
 * The drive letter in that path must still name the held object's volume, checked before Git
 * starts and again once it has. A volume GUID path would avoid drive letters entirely, but Git for
 * Windows' `sh.exe` (transports, credential helpers) hangs in such a working directory.
 *
 * An empty directory (before `init` or `clone`) has no entry to pin; it is rechecked once Git has
 * started. Sources: CreateFileW, OpenFileById, GetFinalPathNameByHandleW, FILE_ID_INFO and
 * FILE_ATTRIBUTE_TAG_INFO on learn.microsoft.com; MS-FSA FSCTL_SET_REPARSE_POINT.
 */
export interface DirectoryLease {
  /** The held directory's canonical drive or UNC path, for the child's working directory. */
  cwd: string;
  /** Confirms the held directory is still a plain directory on its volume; throws otherwise. */
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
  openPath(path: string, access: number, share: number): number | bigint;
  finalPath(handle: number | bigint, buffer: Buffer, flags: number): number;
  /** The `\\?\Volume{...}\` name a drive root such as `C:\` currently mounts. */
  volumeOf(root: string, buffer: Buffer): boolean;
  close(handle: number | bigint): void;
  unload(): void;
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
const VOLUME_NAME_DOS = 0x0;
const VOLUME_NAME_GUID = 0x1;
const leaseAccess = FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
const pathCharacters = 32_768;

function invalid(handle: number | bigint): boolean {
  return handle === -1 || handle === -1n || handle === 0 || handle === 0n;
}

function changed(reason: string): GitError {
  return new GitError("filesystem_error", `The project folder changed: ${reason}`);
}

// koffi loads lazily and only on Windows. uv_get_osfhandle comes from node.exe itself, so the
// descriptor table is the one the daemon's own fd belongs to.
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
    const final = kernel.func(
      "uint32 __stdcall GetFinalPathNameByHandleW(intptr_t file, _Out_ void* path, uint32 characters, uint32 flags)",
    );
    const close = kernel.func("int __stdcall CloseHandle(intptr_t handle)");
    const volume = kernel.func(
      "int __stdcall GetVolumeNameForVolumeMountPointW(str16 root, _Out_ void* name, uint32 characters)",
    );
    // FILE_FLAG_BACKUP_SEMANTICS opens directories; FILE_FLAG_OPEN_REPARSE_POINT never follows.
    const flags = 0x02000000 | 0x00200000;
    const integer = z.number().int();
    return {
      osHandle: (fd) => osHandle(fd),
      fileInfo: (handle, infoClass, buffer) =>
        integer.parse(info(handle, infoClass, buffer, buffer.length)) !== 0,
      openById: (hint, descriptor, access, share) =>
        byId(hint, descriptor, access, share, null, flags),
      // OPEN_EXISTING
      openPath: (path, access, share) => byPath(path, access, share, null, 3, flags, 0),
      finalPath: (handle, buffer, pathFlags) =>
        integer.parse(final(handle, buffer, buffer.length / 2, pathFlags)),
      volumeOf: (root, buffer) => integer.parse(volume(root, buffer, buffer.length / 2)) !== 0,
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

function identity(api: DirectoryLeaseApi, handle: number | bigint): Buffer {
  // FILE_ID_INFO: 8-byte volume serial number, then the 16-byte file ID.
  const info = Buffer.alloc(24);
  if (!api.fileInfo(handle, FileIdInfo, info)) throw changed("its identity is unreadable");
  return info;
}

function plainDirectory(api: DirectoryLeaseApi, handle: number | bigint): void {
  // FILE_ATTRIBUTE_TAG_INFO: attributes, then the reparse tag.
  const tag = Buffer.alloc(8);
  if (!api.fileInfo(handle, FileAttributeTagInfo, tag)) throw changed("it is unreadable");
  const attributes = tag.readUInt32LE(0);
  if ((attributes & FILE_ATTRIBUTE_DIRECTORY) === 0) throw changed("it is not a folder");
  if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) throw changed("it is now a link");
}

function finalPath(api: DirectoryLeaseApi, handle: number | bigint, flags: number): string {
  const buffer = Buffer.alloc(pathCharacters * 2);
  const length = api.finalPath(handle, buffer, flags);
  // Zero is failure; a length at or past the buffer is the size it would need.
  if (length <= 0 || length >= pathCharacters) throw changed("it has no path");
  return buffer.toString("utf16le", 0, length * 2);
}

function finalGuidPath(api: DirectoryLeaseApi, handle: number | bigint): string {
  const path = finalPath(api, handle, VOLUME_NAME_GUID);
  if (!path.startsWith("\\\\?\\Volume{")) throw changed("it has no volume path");
  return path;
}

/** The canonical drive (`C:\\...`) or UNC (`\\\\server\\share\\...`) path of the held object. */
function workingPath(api: DirectoryLeaseApi, handle: number | bigint): string {
  const path = finalPath(api, handle, VOLUME_NAME_DOS);
  if (/^\\\\\?\\[A-Za-z]:\\/.test(path)) return path.slice(4);
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  throw changed("it has no drive path");
}

/** A drive path's letter must mount the held object's volume (`guid` is its volume path). */
function sameVolume(api: DirectoryLeaseApi, path: string, guid: string): void {
  if (path.startsWith("\\\\")) return;
  const buffer = Buffer.alloc(100 * 2);
  if (!api.volumeOf(path.slice(0, 3), buffer)) throw changed("its drive is gone");
  const mounted = buffer.toString("utf16le").replace(/\0.*$/s, "");
  if (!guid.toUpperCase().startsWith(mounted.toUpperCase())) throw changed("its drive moved");
}

/** Leases the directory behind a held descriptor for one Git process. */
export function leaseHeldDirectory(
  fd: number,
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
    const expected = identity(api, held);
    // FILE_ID_DESCRIPTOR: size, type, then the 16-byte extended file ID.
    const descriptor = Buffer.alloc(24);
    descriptor.writeUInt32LE(descriptor.length, 0);
    descriptor.writeUInt32LE(ExtendedFileIdType, 4);
    expected.copy(descriptor, 8, 8, 24);
    const lease = api.openById(held, descriptor, leaseAccess, FILE_SHARE_READ_WRITE);
    if (invalid(lease)) throw changed("it is in use by a rename or delete");
    handles.push(lease);
    if (!identity(api, lease).equals(expected)) throw changed("it was replaced");
    plainDirectory(api, lease);
    const guid = finalGuidPath(api, lease);
    const entry = api.openPath(`${guid}\\.git`, leaseAccess, FILE_SHARE_READ_WRITE);
    if (!invalid(entry)) {
      handles.push(entry);
      // Opened by path: it must still be this directory's own entry.
      const pinned = finalGuidPath(api, entry);
      if (pinned.toUpperCase() !== `${guid}\\.git`.toUpperCase()) throw changed("it moved");
    }
    const cwd = workingPath(api, lease);
    sameVolume(api, cwd, guid);
    plainDirectory(api, lease);
    return {
      cwd,
      verify: () => {
        if (released) throw changed("its lease ended");
        plainDirectory(api, lease);
        sameVolume(api, cwd, guid);
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
