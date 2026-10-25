import {
  close,
  constants,
  fstat,
  read,
  write,
  fstatSync,
  fchmodSync,
  type BigIntStats,
} from "node:fs";
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
      ? windowsBinding().createPrivateFileAt(parent, name)
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
export function createPrivateDirectoryAt(parent: number, name: string): Descriptor {
  if (process.platform !== "win32") {
    mkdirAt(parent, name);
    return openDirectoryAt(parent, name);
  }
  try {
    return new Descriptor(windowsBinding().createPrivateDirectoryAt(parent, name));
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
export function openPrivateMetadataAt(parent: number, name: string): Descriptor {
  try {
    const fd = onWindows()
      ? windowsBinding().openPrivateMetadataAt(parent, name)
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
/** Fd metadata adapter. Implementations observe the caller-held fd directly. */
export interface DescriptorStatSource {
  statSync(fd: number): IdentifiedStats;
  stat(fd: number): Promise<IdentifiedStats>;
}

function fstatAsync(fd: number): Promise<BigIntStats> {
  return new Promise((resolve, reject) =>
    fstat(fd, { bigint: true }, (error, info) => (error ? reject(error) : resolve(info))),
  );
}

const posixDescriptorStats: DescriptorStatSource = {
  statSync(fd: number): IdentifiedStats {
    if (process.platform === "win32")
      throw new Error("Windows descriptor metadata requires native file identity integration");
    return posixStats(fstatSync(fd, { bigint: true }));
  },
  stat(fd: number): Promise<IdentifiedStats> {
    if (process.platform === "win32")
      return Promise.reject(
        new Error("Windows descriptor metadata requires native file identity integration"),
      );
    return fstatAsync(fd).then((info) => posixStats(info));
  },
};

/** Build a Windows fd stat source from a native metadata lookup.
 * Both observations run on the same caller-held fd: bigint display metadata
 * from fstat plus FILE_ID_INFO and reparse-aware mode from statFd. Node's
 * fstat classifies an opened junction as a directory, so native mode owns
 * the type predicates as well. The path is never reopened,
 * so a pathname rename cannot redirect the observation. The caller keeps the
 * fd alive through the async stat.
 */
export function windowsDescriptorStats(statFd: (fd: number) => unknown): DescriptorStatSource {
  const nativeMetadata = Win32FileIdentitySchema.omit({ kind: true }).extend({
    mode: z.number().int().min(0).max(0o177777),
  });
  return {
    statSync(fd: number): IdentifiedStats {
      const info = fstatSync(fd, { bigint: true });
      const fields = nativeMetadata.parse(statFd(fd));
      return identifiedStats(info, { kind: "win32", vol: fields.vol, id: fields.id }, fields.mode);
    },
    stat(fd: number): Promise<IdentifiedStats> {
      return fstatAsync(fd).then((info) => {
        const fields = nativeMetadata.parse(statFd(fd));
        return identifiedStats(
          info,
          { kind: "win32", vol: fields.vol, id: fields.id },
          fields.mode,
        );
      });
    },
  };
}

const windowsDefaultStats: DescriptorStatSource = windowsDescriptorStats((fd) =>
  windowsBinding().statFd(fd),
);
function defaultStats(): DescriptorStatSource {
  if (process.platform === "win32") return windowsDefaultStats;
  return posixDescriptorStats;
}

/** Own a descriptor acquired by openat. Node's callback API accepts it directly.
 * The descriptor owns normal fd lifetime; the stat source only observes it.
 */
export class Descriptor {
  readonly fd: number;
  private readonly statsSource: DescriptorStatSource;
  constructor(fd: number, statsSource?: DescriptorStatSource) {
    this.fd = fd;
    this.statsSource = statsSource ?? defaultStats();
  }
  checkPrivate(owner: number): void {
    try {
      if (process.platform === "win32") {
        windowsBinding().checkPrivateFd(this.fd);
        return;
      }
      const info = this.statSync();
      if (!info.isFile() || info.uid !== owner || info.nlink > 1 || (info.mode & 0o077) !== 0)
        throw new Error("Refusing private descriptor: expected a regular file owned by the owner");
      if (info.nlink === 0)
        throw Object.assign(new Error("Private file was removed during read"), { code: "ENOENT" });
    } catch (error) {
      nativeFailure(error);
    }
  }
  checkPrivateDirectory(): void {
    try {
      if (process.platform === "win32") {
        windowsBinding().checkPrivateDirectoryFd(this.fd);
        return;
      }
      const info = this.statSync();
      if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
        throw new Error("Refusing directory: expected a private directory owned by this user");
    } catch (error) {
      nativeFailure(error);
    }
  }
  chmod(mode: number): void {
    try {
      if (process.platform === "win32") {
        if (mode !== 0o600)
          throw Object.assign(
            new Error(`Unsupported mode ${mode.toString(8)}: Windows private files use 0600`),
            { code: "ENOTSUP" },
          );
        try {
          windowsBinding().checkPrivateFd(this.fd);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EACCES")) throw error;
          windowsBinding().securePrivateFd(this.fd);
        }
        // A protected DACL and the readonly attribute are independent. Node's
        // Windows fchmod clears readonly through the same file object, so an
        // upload recovery must not report 0600 while owner writes remain blocked.
        if ((this.statSync().mode & 0o200) === 0) fchmodSync(this.fd, mode);
        return;
      }
      posixBinding().chmodMetadata(this.fd, mode);
    } catch (error) {
      nativeFailure(error);
    }
  }
  statSync(): IdentifiedStats {
    return this.statsSource.statSync(this.fd);
  }
  stat(): Promise<IdentifiedStats> {
    return this.statsSource.stat(this.fd);
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
