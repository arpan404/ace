import * as koffi from "koffi";
import { z } from "zod";
import { close as closeDescriptor, constants } from "node:fs";
export type OpenCommandChild = (directory: number, name: string, flags: number) => Promise<number>;
export interface DirectoryReader {
  read(): Promise<string | undefined>;
  close(): Promise<void>;
}
const integer = z.number().int();
const pointer = z.bigint().nullable();
export class EntryUnavailable extends Error {}
// OS interface declarations only. No provider or third-party implementation code.
function bindings() {
  if (!["darwin", "linux"].includes(process.platform) || !["arm64", "x64"].includes(process.arch))
    throw new Error("Secure command discovery requires 64-bit macOS or Linux");
  const library = koffi.load(null);
  const suffix = process.platform === "darwin" && process.arch === "x64" ? "$INODE64" : "";
  return {
    open: library.func("int openat(int directory, const char *name, int flags)"),
    create: library.func("int openat(int directory, const char *name, int flags, ...)"),
    readlink: library.func(
      "int readlinkat(int directory, const char *name, void *buffer, unsigned long size)",
    ),
    mkdir: library.func("int mkdirat(int directory, const char *name, unsigned int mode)"),
    rename: library.func(
      "int renameat(int olddir, const char *oldname, int newdir, const char *newname)",
    ),
    unlink: library.func("int unlinkat(int directory, const char *name, int flags)"),
    link: library.func(
      "int linkat(int olddir, const char *oldname, int newdir, const char *newname, int flags)",
    ),
    symlink: library.func("int symlinkat(const char *target, int directory, const char *name)"),
    // renameatx_np (macOS) and renameat2 (Linux) take the same arguments; only flag values differ.
    renameFlags:
      process.platform === "darwin"
        ? library.func(
            "int renameatx_np(int olddir, const char *oldname, int newdir, const char *newname, unsigned int flags)",
          )
        : library.func(
            "int renameat2(int olddir, const char *oldname, int newdir, const char *newname, unsigned int flags)",
          ),
    directory: library.func(`fdopendir${suffix}`, "void *", ["int"]),
    next: library.func(`readdir${suffix}`, "void *", ["void *"]),
    close: library.func("int closedir(void *directory)"),
  };
}
let native: ReturnType<typeof bindings> | undefined;
function api() {
  return (native ??= bindings());
}
async function call(
  fn: { async(...input: unknown[]): unknown },
  ...args: unknown[]
): Promise<unknown> {
  return new Promise((resolve, reject) =>
    fn.async(...args, (error: unknown, result: unknown) =>
      error ? reject(error) : resolve(result),
    ),
  );
}
const closeOnExec = process.platform === "darwin" ? 0x1000000 : 0x80000;
export const directoryFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | closeOnExec;
export const fileFlags =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec;
export const openCommandChild: OpenCommandChild = async (directory, name, flags) => {
  const fd = integer.parse(await call(api().open, directory, name, flags));
  if (fd < 0) throw new EntryUnavailable("Cannot open command entry without following symlinks");
  return fd;
};
export async function directoryReader(fd: number): Promise<DirectoryReader> {
  const handle = pointer.parse(await call(api().directory, fd));
  if (handle === null) throw new Error("Cannot enumerate command directory");
  let closed = false;
  return {
    async read() {
      if (closed) return undefined;
      const entry = pointer.parse(await call(api().next, handle));
      if (entry === null) return undefined;
      // Public dirent ABIs: Linux 64-bit d_name at 19; Darwin inode64 at 21.
      const offset = process.platform === "darwin" ? 21 : 19;
      const value: unknown = koffi.decode(entry, offset, "char", -1);
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
        integer.parse(await call(api().close, handle));
      }
    },
  };
}

/** Small descriptor-relative mutation primitives, shared by prompt file editing. */
export async function createCommandDirectory(directory: number, name: string): Promise<void> {
  await call(api().mkdir, directory, name, 0o700);
  // The caller opens the result with O_NOFOLLOW, including when mkdir found an existing entry.
}
export async function createCommandFile(directory: number, name: string): Promise<number> {
  // Koffi variadic calls are synchronous; openat is one bounded descriptor operation.
  const fd = integer.parse(
    api().create(
      directory,
      name,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        closeOnExec,
      "unsigned int",
      0o600,
    ),
  );
  if (fd < 0) throw new EntryUnavailable("Cannot create prompt file");
  return fd;
}
export async function replaceCommandFile(
  directory: number,
  source: string,
  target: string,
): Promise<void> {
  if (integer.parse(await call(api().rename, directory, source, directory, target)) < 0)
    throw new Error("Cannot replace prompt file");
}
export async function removeCommandFile(directory: number, name: string): Promise<void> {
  await call(api().unlink, directory, name, 0);
}
export async function linkCommandFile(
  directory: number,
  source: string,
  target: string,
): Promise<void> {
  if (integer.parse(await call(api().link, directory, source, directory, target, 0)) < 0)
    throw new Error("prompt_conflict");
}

/** Read the link itself relative to the pinned skill directory, never its target. */
export async function readCommandLink(directory: number, name: string): Promise<string> {
  const bytes = Buffer.alloc(4096);
  const count = integer.parse(await call(api().readlink, directory, name, bytes, bytes.length));
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
  return integer.parse(await call(api().mkdir, directory, name, mode)) === 0;
}
/** unlinkat of a file, symlink (never its target) or, with `folder`, an empty directory. */
export async function removeCommandEntry(
  directory: number,
  name: string,
  folder: boolean,
): Promise<boolean> {
  return (
    integer.parse(await call(api().unlink, directory, name, folder ? removeDirectoryFlag : 0)) === 0
  );
}
/** renameat between two pinned directories; neither name is followed. */
export async function renameCommandEntry(
  fromDirectory: number,
  from: string,
  toDirectory: number,
  to: string,
): Promise<boolean> {
  return integer.parse(await call(api().rename, fromDirectory, from, toDirectory, to)) === 0;
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
  const flags = renameModes[mode];
  return (
    integer.parse(await call(api().renameFlags, fromDirectory, from, toDirectory, to, flags)) === 0
  );
}
/** symlinkat: `name` in the pinned directory, storing `target` as text; fails if `name` exists. */
export async function linkCommandEntry(
  target: string,
  directory: number,
  name: string,
): Promise<boolean> {
  return integer.parse(await call(api().symlink, target, directory, name)) === 0;
}
