import { close, constants, fstat, read, write, fstatSync, type BigIntStats } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { getSystemErrorName } from "node:util";
import { z } from "zod";
import {
  identifiedStats,
  posixStats,
  Win32FileIdentitySchema,
  FileIdentitySchema,
  type IdentifiedStats,
} from "./file-identity.ts";
import { DIRECTORY_CAP, WorkspaceError } from "./types.ts";

const require = createRequire(import.meta.url);
const Binding = z.object({
  pipe: z.function({
    input: [],
    output: z.object({
      read: z.number().int().nonnegative(),
      write: z.number().int().nonnegative(),
    }),
  }),
  openRoot: z.function({ input: [z.string()], output: z.number().int().nonnegative() }),
  openAt: z.function({
    input: [z.number().int(), z.string(), z.number().int()],
    output: z.number().int().nonnegative(),
  }),
  openMetadataAt: z.function({
    input: [z.number().int(), z.string()],
    output: z.number().int().nonnegative(),
  }),
  chmodMetadata: z.function({
    input: [z.number().int().nonnegative(), z.number().int().min(0).max(0o777)],
    output: z.void(),
  }),
  unlinkAt: z.function({ input: [z.number().int(), z.string()], output: z.void() }),
  removeDirectoryAt: z.function({ input: [z.number().int(), z.string()], output: z.void() }),
  renameAt: z.function({ input: [z.number().int(), z.string(), z.string()], output: z.void() }),
  mkdirAt: z.function({ input: [z.number().int(), z.string()], output: z.void() }),
  statAt: z.function({
    input: [z.number().int(), z.string()],
    output: z.object({
      dev: z.number(),
      ino: z.number(),
      identity: FileIdentitySchema,
      mode: z.number().int(),
      size: z.number(),
      mtime: z.number(),
    }),
  }),
  names: z.function({
    input: [z.number().int(), z.number().int()],
    output: z.array(z.string()).max(DIRECTORY_CAP),
  }),
});
let loaded: z.infer<typeof Binding> | undefined;
function binding(): z.infer<typeof Binding> {
  // Importing the shared service API needs no native addon. Filesystem operations load it on demand.
  if (!loaded) {
    let native: unknown;
    try {
      native = require("../dist/descriptor.node");
    } catch (error) {
      if (
        !process.versions.electron ||
        !(error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND")
      )
        throw error;
      native = require(
        join(
          z.object({ resourcesPath: z.string().min(1) }).parse(process).resourcesPath,
          "daemon/descriptor.node",
        ),
      );
    }
    loaded = Binding.parse(native);
  }
  return loaded;
}
function nativeFailure(error: unknown): never {
  if (error instanceof Error && "errno" in error && typeof error.errno === "number") {
    const code = getSystemErrorName(error.errno);
    if (code === "E2BIG")
      throw new WorkspaceError("LIMIT_EXCEEDED", "Directory exceeds 10,000 entries");
    Object.assign(error, { code });
  }
  throw error;
}
export function openAt(parent: number, name: string, flags: number): Descriptor {
  try {
    return new Descriptor(binding().openAt(parent, name, flags));
  } catch (error) {
    return nativeFailure(error);
  }
}
export function openDirectoryAt(parent: number, name: string): Descriptor {
  return openAt(parent, name, constants.O_RDONLY | constants.O_DIRECTORY);
}
export function openFileAt(parent: number, name: string): Descriptor {
  return openAt(parent, name, constants.O_RDONLY);
}
export function createFileAt(parent: number, name: string): Descriptor {
  return openAt(parent, name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
}
export function openMetadataAt(parent: number, name: string): Descriptor {
  try {
    return new Descriptor(binding().openMetadataAt(parent, name));
  } catch (error) {
    return nativeFailure(error);
  }
}
export function mkdirAt(parent: number, name: string): void {
  try {
    binding().mkdirAt(parent, name);
  } catch (error) {
    nativeFailure(error);
  }
}
export function descriptorNames(fd: number, limit = DIRECTORY_CAP): string[] {
  try {
    return binding().names(fd, limit).toSorted();
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

/** Own a descriptor acquired by openat. Node's callback API accepts it directly.
 * The descriptor owns normal fd lifetime; the stat source only observes it.
 */
export class Descriptor {
  readonly fd: number;
  private readonly statsSource: DescriptorStatSource;
  constructor(fd: number, statsSource: DescriptorStatSource = posixDescriptorStats) {
    this.fd = fd;
    this.statsSource = statsSource;
  }
  chmod(mode: number): void {
    try {
      binding().chmodMetadata(this.fd, mode);
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
    return binding().statAt(parent, name);
  } catch (error) {
    return nativeFailure(error);
  }
}

export function openRoot(path: string): Descriptor {
  try {
    return new Descriptor(binding().openRoot(path));
  } catch (error) {
    return nativeFailure(error);
  }
}

export function pipeDescriptors() {
  try {
    return binding().pipe();
  } catch (error) {
    return nativeFailure(error);
  }
}

export function unlinkAt(parent: number, name: string): void {
  try {
    binding().unlinkAt(parent, name);
  } catch (error) {
    nativeFailure(error);
  }
}
/** Removes an empty child directory; a symlink of that name is never followed. */
export function removeDirectoryAt(parent: number, name: string): void {
  try {
    binding().removeDirectoryAt(parent, name);
  } catch (error) {
    nativeFailure(error);
  }
}
export function renameAt(parent: number, from: string, to: string): void {
  try {
    binding().renameAt(parent, from, to);
  } catch (error) {
    nativeFailure(error);
  }
}
