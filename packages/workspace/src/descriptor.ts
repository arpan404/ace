import { close, constants, fstat, read, write, fstatSync, type BigIntStats } from "node:fs";
import { getSystemErrorName } from "node:util";
import { z } from "zod";
import {
  identifiedStats,
  posixStats,
  Win32FileIdentitySchema,
  type IdentifiedStats,
} from "./file-identity.ts";
import { posixBinding, windowsBinding } from "./descriptor-native.ts";
import { DIRECTORY_CAP, WorkspaceError } from "./types.ts";

function nativeFailure(error: unknown): never {
  if (error instanceof Error) {
    const existing = "code" in error ? error.code : undefined;
    if (existing === "E2BIG")
      throw new WorkspaceError("LIMIT_EXCEEDED", "Directory exceeds 10,000 entries");
    if ("errno" in error && typeof error.errno === "number") {
      const code = getSystemErrorName(error.errno);
      if (code === "E2BIG")
        throw new WorkspaceError("LIMIT_EXCEEDED", "Directory exceeds 10,000 entries");
      if (existing === undefined) Object.assign(error, { code });
    }
  }
  throw error;
}
function onWindows(): boolean {
  return process.platform === "win32";
}
export function openRoot(path: string): Descriptor {
  try {
    const fd = onWindows() ? windowsBinding().openRoot(path) : posixBinding().openRoot(path);
    return new Descriptor(fd);
  } catch (error) {
    return nativeFailure(error);
  }
}
export function openDirectoryAt(parent: number, name: string): Descriptor {
  try {
    const fd = onWindows()
      ? windowsBinding().openDirectoryAt(parent, name)
      : posixBinding().openAt(parent, name, constants.O_RDONLY | constants.O_DIRECTORY);
    return new Descriptor(fd);
  } catch (error) {
    return nativeFailure(error);
  }
}
export function openFileAt(parent: number, name: string): Descriptor {
  try {
    const fd = onWindows()
      ? windowsBinding().openFileAt(parent, name)
      : posixBinding().openAt(parent, name, constants.O_RDONLY);
    return new Descriptor(fd);
  } catch (error) {
    return nativeFailure(error);
  }
}
export function createFileAt(parent: number, name: string): Descriptor {
  try {
    const fd = onWindows()
      ? windowsBinding().createFileAt(parent, name)
      : posixBinding().openAt(
          parent,
          name,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        );
    return new Descriptor(fd);
  } catch (error) {
    return nativeFailure(error);
  }
}
export function openMetadataAt(parent: number, name: string): Descriptor {
  try {
    const fd = onWindows()
      ? windowsBinding().openMetadataAt(parent, name)
      : posixBinding().openMetadataAt(parent, name);
    return new Descriptor(fd);
  } catch (error) {
    return nativeFailure(error);
  }
}
export function mkdirAt(parent: number, name: string): void {
  try {
    if (onWindows()) windowsBinding().mkdirAt(parent, name);
    else posixBinding().mkdirAt(parent, name);
  } catch (error) {
    nativeFailure(error);
  }
}
/** Creates a symlink in `parent` without resolving its target or following `name`. */
export function symlinkAt(parent: number, target: string, name: string): void {
  try {
    if (onWindows())
      throw Object.assign(new Error("Symbolic-link creation is unavailable on Windows"), {
        code: "ENOTSUP",
      });
    posixBinding().symlinkAt(parent, target, name);
  } catch (error) {
    nativeFailure(error);
  }
}
export function descriptorNames(fd: number, limit = DIRECTORY_CAP): string[] {
  try {
    const names = onWindows() ? windowsBinding().names(fd, limit) : posixBinding().names(fd, limit);
    return names.toSorted();
  } catch (error) {
    return nativeFailure(error);
  }
}
function fstatAsync(fd: number): Promise<BigIntStats> {
  return new Promise((resolve, reject) =>
    fstat(fd, { bigint: true }, (error, info) => (error ? reject(error) : resolve(info))),
  );
}

const WindowsFdMetadata = Win32FileIdentitySchema.omit({ kind: true }).extend({
  mode: z.number().int().min(0).max(0o177777),
});
/** Node's Windows dev/ino are lossy and its fstat reports an opened junction as a directory,
 * so identity and type come from the native FILE_ID_INFO read on the same held fd. */
function identify(fd: number, info: BigIntStats): IdentifiedStats {
  if (process.platform !== "win32") return posixStats(info);
  const fields = WindowsFdMetadata.parse(windowsBinding().statFd(fd));
  return identifiedStats(info, { kind: "win32", vol: fields.vol, id: fields.id }, fields.mode);
}

/** Own a descriptor acquired by openat. Node's callback API accepts it directly. */
export class Descriptor {
  readonly fd: number;
  constructor(fd: number) {
    this.fd = fd;
  }
  chmod(mode: number): void {
    // Windows has no POSIX mode bits; the folder's inherited ACL governs access.
    if (process.platform === "win32") return;
    try {
      posixBinding().chmodMetadata(this.fd, mode);
    } catch (error) {
      nativeFailure(error);
    }
  }
  statSync(): IdentifiedStats {
    return identify(this.fd, fstatSync(this.fd, { bigint: true }));
  }
  async stat(): Promise<IdentifiedStats> {
    return identify(this.fd, await fstatAsync(this.fd));
  }
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }> {
    return new Promise((resolve, reject) =>
      read(this.fd, buffer, offset, length, position, (error, bytesRead) =>
        error ? reject(error) : resolve({ bytesRead }),
      ),
    );
  }
  close(): Promise<void> {
    return new Promise((resolve, reject) =>
      close(this.fd, (error) => (error ? reject(error) : resolve())),
    );
  }
  async write(bytes: Buffer): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      const count = await new Promise<number>((resolve, reject) =>
        write(this.fd, bytes, offset, bytes.length - offset, offset, (error, written) =>
          error ? reject(error) : resolve(written),
        ),
      );
      if (!count) throw new Error("Short descriptor write");
      offset += count;
    }
  }
}

export function statAt(parent: number, name: string) {
  try {
    if (process.platform === "win32") {
      const raw = windowsBinding().statAt(parent, name);
      return {
        identity: { kind: "win32" as const, vol: raw.vol, id: raw.id },
        mode: raw.mode,
        size: raw.size,
        mtime: raw.mtimeMs,
      };
    }
    return posixBinding().statAt(parent, name);
  } catch (error) {
    return nativeFailure(error);
  }
}

export function pipeDescriptors() {
  try {
    if (process.platform === "win32")
      throw Object.assign(new Error("pipeDescriptors is not supported on Windows"), {
        code: "ENOTSUP",
      });
    return posixBinding().pipe();
  } catch (error) {
    return nativeFailure(error);
  }
}

export function unlinkAt(parent: number, name: string): void {
  try {
    if (onWindows()) windowsBinding().unlinkAt(parent, name);
    else posixBinding().unlinkAt(parent, name);
  } catch (error) {
    nativeFailure(error);
  }
}
/** Removes an empty child directory; a symlink of that name is never followed. */
export function removeDirectoryAt(parent: number, name: string): void {
  try {
    if (onWindows()) windowsBinding().removeDirectoryAt(parent, name);
    else posixBinding().removeDirectoryAt(parent, name);
  } catch (error) {
    nativeFailure(error);
  }
}
export function renameAt(parent: number, from: string, to: string): void {
  try {
    if (onWindows()) windowsBinding().renameAt(parent, from, to);
    else posixBinding().renameAt(parent, from, to);
  } catch (error) {
    nativeFailure(error);
  }
}
