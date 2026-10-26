import { close, fstat, read, write, type Stats } from "node:fs";
import { closeSync, constants, fstatSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { getSystemErrorName } from "node:util";
import { z } from "zod";
import { windowsNameAllowed } from "./path-policy.ts";
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
  symlinkAt: z.function({
    input: [z.number().int(), z.string(), z.string()],
    output: z.void(),
  }),
  statAt: z.function({
    input: [z.number().int(), z.string()],
    output: z.object({
      dev: z.number(),
      ino: z.number(),
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
  if (process.platform === "win32") return new Descriptor(windowsOpenAt(parent, name, flags));
  try {
    return new Descriptor(binding().openAt(parent, name, flags));
  } catch (error) {
    return nativeFailure(error);
  }
}
export function openMetadataAt(parent: number, name: string): Descriptor {
  if (process.platform === "win32")
    return new Descriptor(windowsCall(() => windows().openMetadataAt(parent, windowsName(name))));
  try {
    return new Descriptor(binding().openMetadataAt(parent, name));
  } catch (error) {
    return nativeFailure(error);
  }
}
export function mkdirAt(parent: number, name: string): void {
  if (process.platform === "win32")
    return windowsCall(() => windows().mkdirAt(parent, windowsName(name)));
  try {
    binding().mkdirAt(parent, name);
  } catch (error) {
    nativeFailure(error);
  }
}
/** Creates a symlink in `parent` without resolving its target or following `name`. */
export function symlinkAt(parent: number, target: string, name: string): void {
  if (process.platform === "win32")
    throw failed("Windows links need a privilege ace never asks for", "ENOTSUP");
  try {
    binding().symlinkAt(parent, target, name);
  } catch (error) {
    nativeFailure(error);
  }
}
export function descriptorNames(fd: number, limit = DIRECTORY_CAP): string[] {
  if (process.platform === "win32") return windowsCall(() => windows().names(fd, limit)).toSorted();
  try {
    return binding().names(fd, limit).toSorted();
  } catch (error) {
    return nativeFailure(error);
  }
}
/** Own a descriptor acquired by openat. Node's callback API accepts it directly. */
export class Descriptor {
  readonly fd: number;
  constructor(fd: number) {
    this.fd = fd;
  }
  chmod(mode: number): void {
    // Windows has no mode bits; the folder's inherited ACL governs access.
    if (process.platform === "win32") return;
    try {
      binding().chmodMetadata(this.fd, mode);
    } catch (error) {
      nativeFailure(error);
    }
  }
  stat(): Promise<Stats> {
    if (process.platform === "win32") return Promise.resolve().then(() => statWindowsFd(this.fd));
    return new Promise((resolve, reject) =>
      fstat(this.fd, (error, info) => (error ? reject(error) : resolve(info))),
    );
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
  if (process.platform === "win32") {
    const child = openMetadataAt(parent, name);
    try {
      const facts = windowsCall(() => windows().statFd(child.fd));
      const { dev, ino } = fstatSync(child.fd);
      return {
        dev,
        ino,
        ...windowsIdentity(facts),
        size: facts.size,
        mtime: windowsTime(facts.writeTime),
      };
    } finally {
      closeSync(child.fd);
    }
  }
  try {
    return binding().statAt(parent, name);
  } catch (error) {
    return nativeFailure(error);
  }
}

export function openRoot(path: string): Descriptor {
  if (process.platform === "win32")
    return new Descriptor(windowsCall(() => windows().openRoot(windowsRoot(path))));
  try {
    return new Descriptor(binding().openRoot(path));
  } catch (error) {
    return nativeFailure(error);
  }
}

export function pipeDescriptors() {
  if (process.platform === "win32") throw failed("Windows has no descriptor pipes", "ENOTSUP");
  try {
    return binding().pipe();
  } catch (error) {
    return nativeFailure(error);
  }
}

export function unlinkAt(parent: number, name: string): void {
  if (process.platform === "win32")
    return windowsCall(() => windows().unlinkAt(parent, windowsName(name)));
  try {
    binding().unlinkAt(parent, name);
  } catch (error) {
    nativeFailure(error);
  }
}
/** Removes an empty child directory; a symlink of that name is never followed. */
export function removeDirectoryAt(parent: number, name: string): void {
  if (process.platform === "win32")
    return windowsCall(() => windows().removeDirectoryAt(parent, windowsName(name)));
  try {
    binding().removeDirectoryAt(parent, name);
  } catch (error) {
    nativeFailure(error);
  }
}
export function renameAt(parent: number, from: string, to: string): void {
  if (process.platform === "win32")
    return windowsCall(() => windows().renameAt(parent, windowsName(from), windowsName(to)));
  try {
    binding().renameAt(parent, from, to);
  } catch (error) {
    nativeFailure(error);
  }
}

// Windows: the same operations through native/windows/descriptor.c. TypeScript owns the name
// rules, so every name is checked before it reaches the addon.
const handle = z.number().int().nonnegative();
const child = z.function({ input: [z.number().int(), z.string()], output: handle });
const change = z.function({ input: [z.number().int(), z.string()], output: z.void() });
/** What Windows reports about an open handle: FILE_ID_INFO bytes, attributes, size, FILETIME. */
const WindowsFacts = z.object({
  id: z.instanceof(Uint8Array).refine((bytes) => bytes.length === 24),
  attributes: z.number().int().nonnegative(),
  size: z.number().nonnegative(),
  writeTime: z.bigint(),
});
const WindowsBinding = z.object({
  openRoot: z.function({ input: [z.string()], output: handle }),
  openAt: child,
  createFileAt: child,
  openMetadataAt: child,
  mkdirAt: change,
  unlinkAt: change,
  removeDirectoryAt: change,
  renameAt: z.function({ input: [z.number().int(), z.string(), z.string()], output: z.void() }),
  statFd: z.function({ input: [z.number().int()], output: WindowsFacts }),
  names: z.function({
    input: [z.number().int(), z.number().int()],
    output: z.array(z.string()).max(DIRECTORY_CAP),
  }),
});
let windowsLoaded: z.infer<typeof WindowsBinding> | undefined;
function windows(): z.infer<typeof WindowsBinding> {
  windowsLoaded ??= WindowsBinding.parse(require("../dist/descriptor.node"));
  return windowsLoaded;
}
function failed(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}
function windowsCall<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "E2BIG")
      throw new WorkspaceError("LIMIT_EXCEEDED", "Directory exceeds 10,000 entries");
    throw error;
  }
}
function windowsName(name: string): string {
  if (!windowsNameAllowed(name)) throw failed(`Invalid Windows file name: ${name}`, "EINVAL");
  return name;
}
/** Only drive-absolute roots: device namespaces are refused and UNC shares are not supported. */
function windowsRoot(path: string): string {
  if (/^[\\/]{2}[?.][\\/]|^\\\?\?\\/.test(path))
    throw failed(`Refusing device path: ${path}`, "EINVAL");
  if (/^[\\/]{2}/.test(path)) throw failed(`UNC roots are not supported: ${path}`, "ENOTSUP");
  const parts = path.slice(3).split(/[\\/]/);
  if (
    !/^[A-Za-z]:[\\/]/.test(path) ||
    !parts.every((part) => part === "" || windowsNameAllowed(part))
  )
    throw failed(`Refusing Windows root: ${path}`, "EINVAL");
  return path;
}
/** Windows has no O_DIRECTORY: reads open a file or directory, creation is always exclusive. */
function windowsOpenAt(parent: number, name: string, flags: number): number {
  windowsName(name);
  if (flags & constants.O_CREAT) {
    if (!(flags & constants.O_EXCL)) throw failed("Windows creates files exclusively", "ENOTSUP");
    return windowsCall(() => windows().createFileAt(parent, name));
  }
  if (flags & (constants.O_WRONLY | constants.O_RDWR))
    throw failed("Windows opens existing files read-only", "ENOTSUP");
  return windowsCall(() => windows().openAt(parent, name));
}
/**
 * Windows identity has one source: dev and ino are always Node's own fstat values, so stats
 * from Node and from this module compare equal wherever they are persisted or checked. Node
 * rounds file ids above 2^53, so this module's own checks also compare the exact volume
 * serial and 128-bit file id carried under `windowsFileId`.
 */
const windowsFileId = Symbol("windowsFileId");
/** False only when both stats carry exact Windows ids and those ids differ. */
export function sameWindowsFile(a: object, b: object): boolean {
  const left: unknown = Reflect.get(a, windowsFileId);
  const right: unknown = Reflect.get(b, windowsFileId);
  return left === undefined || right === undefined || left === right;
}
/** Type from the handle's attributes: a junction or symlink reads as a link, never its target. */
function windowsIdentity(facts: z.infer<typeof WindowsFacts>) {
  const readonly = facts.attributes & 0x1;
  const mode =
    facts.attributes & 0x400
      ? 0o120777
      : facts.attributes & 0x10
        ? readonly
          ? 0o40555
          : 0o40777
        : readonly
          ? 0o100444
          : 0o100666;
  return { mode, [windowsFileId]: Buffer.from(facts.id).toString("hex") };
}
/** FILETIME ticks (100 ns since 1601) as Unix milliseconds; earlier than 1970 stays negative. */
function windowsTime(ticks: bigint): number {
  const delta = ticks - 116444736000000000n;
  return Number(delta / 10000n) + Number(delta % 10000n) / 10000;
}
/** Node's fstat with the type and exact file id read from the same Windows handle. */
export function statWindowsFd(fd: number): Stats {
  return Object.assign(fstatSync(fd), windowsIdentity(windowsCall(() => windows().statFd(fd))));
}
