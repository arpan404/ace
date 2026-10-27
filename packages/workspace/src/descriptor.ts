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
    return new Descriptor(
      windowsCall(() => windowsHot().openMetadataAt(parent, windowsName(name))),
    );
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
      const facts = windowsCall(() => windowsHot().statFd(child.fd));
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
/** The Windows add-on's link and no-replace calls, which have no POSIX counterpart here. */
const WindowsLinkBinding = z.object({
  renameAt: z.function({
    input: [z.number().int(), z.string(), z.string(), z.literal(false)],
    output: z.void(),
  }),
  junctionAt: z.function({ input: [z.number().int(), z.string(), z.string()], output: z.void() }),
});
let windowsLinksLoaded: z.infer<typeof WindowsLinkBinding> | undefined;
function windowsLinks(): z.infer<typeof WindowsLinkBinding> {
  windowsLinksLoaded ??= WindowsLinkBinding.parse(require("../dist/descriptor.node"));
  return windowsLinksLoaded;
}
/** Windows: moves `from` to `to` in `parent`, failing with EEXIST rather than replacing `to`. */
export function renameAtNoReplace(parent: number, from: string, to: string): void {
  if (process.platform !== "win32") throw failed("Only the Windows add-on has this", "ENOTSUP");
  windowsCall(() => windowsLinks().renameAt(parent, windowsName(from), windowsName(to), false));
}
/**
 * Windows: makes `name` in the pinned `parent` a junction to `target`, a normalized
 * drive-absolute path. The junction is created through the parent's handle, never its path.
 */
export function junctionAt(parent: number, name: string, target: string): void {
  if (process.platform !== "win32") throw failed("Only the Windows add-on has this", "ENOTSUP");
  if (
    !/^[A-Za-z]:\\/.test(target) ||
    target.includes("/") ||
    target.includes("\0") ||
    !target
      .slice(3)
      .split("\\")
      .every(
        (part, index, parts) =>
          windowsNameAllowed(part) || (part === "" && index === parts.length - 1),
      )
  )
    throw failed(`Refusing junction target: ${target}`, "EINVAL");
  windowsCall(() => windowsLinks().junctionAt(parent, windowsName(name), target));
}
let windowsLoaded: z.infer<typeof WindowsBinding> | undefined;
function windows(): z.infer<typeof WindowsBinding> {
  windowsLoaded ??= WindowsBinding.parse(require("../dist/descriptor.node"));
  return windowsLoaded;
}
/**
 * The per-file calls of listing and search without zod's per-call function wrappers, which
 * cost more than the native call itself. The binding's shape is still parsed once by
 * windows(); results here are checked by hand.
 */
const NativeCall = z.custom<(...args: (number | string)[]) => unknown>(
  (value) => typeof value === "function",
);
const WindowsHotBinding = z.object({
  openAt: NativeCall,
  openMetadataAt: NativeCall,
  statFd: NativeCall,
  namesWithFacts: NativeCall,
});
let windowsHotLoaded:
  | {
      openAt(parent: number, name: string): number;
      openMetadataAt(parent: number, name: string): number;
      statFd(fd: number): z.infer<typeof WindowsFacts>;
      namesWithFacts(fd: number, limit: number): unknown;
    }
  | undefined;
function windowsHot(): NonNullable<typeof windowsHotLoaded> {
  if (!windowsHotLoaded) {
    windows();
    const raw = WindowsHotBinding.parse(require("../dist/descriptor.node"));
    windowsHotLoaded = {
      openAt: (parent, name) => windowsHandle(raw.openAt(parent, name)),
      openMetadataAt: (parent, name) => windowsHandle(raw.openMetadataAt(parent, name)),
      statFd: (fd) => windowsFacts(raw.statFd(fd)),
      namesWithFacts: (fd, limit) => raw.namesWithFacts(fd, limit),
    };
  }
  return windowsHotLoaded;
}
const WindowsListing = z
  .object({
    names: z.array(z.string()).max(DIRECTORY_CAP),
    attributes: z.array(z.number().int().nonnegative()),
    sizes: z.array(z.number().nonnegative()),
    writeTimes: z.array(z.bigint()),
  })
  .refine(
    (listing) =>
      listing.attributes.length === listing.names.length &&
      listing.sizes.length === listing.names.length &&
      listing.writeTimes.length === listing.names.length,
    "Every listed name carries its facts",
  );
/**
 * Win32: a directory's entries with the type, size and write time its enumeration already
 * read, without opening each entry. NTFS may lag the size and time of a file another process
 * holds open for writing, so only callers that need just the type (search passes) use this.
 */
export function windowsListing(fd: number, limit = DIRECTORY_CAP) {
  const listing = WindowsListing.parse(windowsCall(() => windowsHot().namesWithFacts(fd, limit)));
  const { dev } = fstatSync(fd);
  return listing.names
    .map((name, index) => ({
      name,
      info: {
        dev,
        // A pass compares no identities; the per-entry file id is left unread.
        ino: 0,
        mode: windowsMode(listing.attributes[index] ?? 0x400),
        size: listing.sizes[index] ?? 0,
        mtime: windowsTime(listing.writeTimes[index] ?? 0n),
      },
    }))
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
function windowsHandle(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw failed("The Windows descriptor add-on returned a malformed handle", "EIO");
}
function windowsFacts(value: unknown): z.infer<typeof WindowsFacts> {
  if (typeof value === "object" && value !== null) {
    const id: unknown = Reflect.get(value, "id");
    const attributes: unknown = Reflect.get(value, "attributes");
    const size: unknown = Reflect.get(value, "size");
    const writeTime: unknown = Reflect.get(value, "writeTime");
    if (
      id instanceof Uint8Array &&
      id.length === 24 &&
      typeof attributes === "number" &&
      Number.isInteger(attributes) &&
      attributes >= 0 &&
      typeof size === "number" &&
      size >= 0 &&
      typeof writeTime === "bigint"
    )
      return { id: new Uint8Array(id), attributes, size, writeTime };
  }
  throw failed("The Windows descriptor add-on returned malformed file facts", "EIO");
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
  return windowsCall(() => windowsHot().openAt(parent, name));
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
function windowsMode(attributes: number): number {
  const readonly = attributes & 0x1;
  return attributes & 0x400
    ? 0o120777
    : attributes & 0x10
      ? readonly
        ? 0o40555
        : 0o40777
      : readonly
        ? 0o100444
        : 0o100666;
}
function windowsIdentity(facts: z.infer<typeof WindowsFacts>) {
  const mode = windowsMode(facts.attributes);
  return {
    mode,
    [windowsFileId]: Buffer.from(facts.id).toString("hex"),
    [windowsAttributes]: facts.attributes,
  };
}
const windowsAttributes = Symbol("windowsAttributes");
/**
 * True when Windows says the file's bytes are on this disk: offline and recall-on-access
 * files (cloud placeholders such as OneDrive's) may download when read.
 */
export function windowsBytesLocal(info: object): boolean {
  const attributes: unknown = Reflect.get(info, windowsAttributes);
  // FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_RECALL_ON_OPEN, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS
  return typeof attributes === "number" && (attributes & (0x1000 | 0x40000 | 0x400000)) === 0;
}
/** FILETIME ticks (100 ns since 1601) as Unix milliseconds; earlier than 1970 stays negative. */
function windowsTime(ticks: bigint): number {
  const delta = ticks - 116444736000000000n;
  return Number(delta / 10000n) + Number(delta % 10000n) / 10000;
}
/** Node's fstat with the type and exact file id read from the same Windows handle. */
export function statWindowsFd(fd: number): Stats {
  return Object.assign(fstatSync(fd), windowsIdentity(windowsCall(() => windowsHot().statFd(fd))));
}
