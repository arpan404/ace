import { close, constants, fchmod, fstat, fsync, read, write } from "node:fs";
import { dirname, resolve } from "node:path";
import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import type { PosixLanes, PosixLimits } from "./posix-lanes.ts";
import { PosixCallOwner } from "./posix-owner.ts";
import { created } from "./posix-ops.ts";
import { posixWorkerLanes } from "./posix-worker-client.ts";
import { PosixStat, posixChunkLimit, type PosixOperation, type PosixValue } from "./posix-wire.ts";

/** Runs calls for whoever is asking; an owner's calls stop when it is cancelled. */
export interface CommandCalls {
  run(root: string, operation: PosixOperation): Promise<{ value: PosixValue }>;
  /** The lanes themselves, without cancellation. */
  cleanup(): PosixLanes;
}

// Every POSIX call runs on a worker thread of its root: a stalled network, FUSE or cloud mount
// blocks that root's thread, never the daemon's event loop, its file thread pool, or another
// root. On POSIX the numbers these functions take and return are handles (posix-lanes.ts), never
// descriptor numbers; on Windows they are the add-on's descriptors.
let lanes: PosixLanes | undefined;
export const commandLanes = () => (lanes ??= posixWorkerLanes());
/** Tests only: later calls use `replacement`. Returns the restore. */
export function useCommandLanes(replacement: PosixLanes): () => void {
  const previous = lanes;
  lanes = replacement;
  return () => {
    lanes = previous;
  };
}
/**
 * The one lane key for a folder: its absolute path, normalised once. Every caller names a root
 * by its anchor (discovery's trusted root or a skill root's parent), so one folder reached by
 * different callers shares one lane.
 */
export const commandLane = (anchor: string) => resolve(anchor);
/** The lane of a skill root, named the way discovery names it: by the root's parent. */
export const skillLane = (skillRoot: string) => commandLane(dirname(skillRoot));
const integer = z.number().int();
const bytesValue = z.instanceof(Uint8Array);
const textValue = z.string();
const namesValue = z.array(z.string());
const lanesOf = (owner: CommandCalls | undefined) => owner?.cleanup() ?? commandLanes();
/** The root an open handle belongs to; unknown handles are refused when used. */
export const rootOf = (handle: number, owner?: CommandCalls) => lanesOf(owner).rootOf(handle) ?? "";

export async function posix(
  operation: PosixOperation,
  handle: number,
  owner?: CommandCalls,
): Promise<PosixValue> {
  return (await (owner ?? commandLanes()).run(rootOf(handle, owner), operation)).value;
}
export async function posixInteger(
  operation: PosixOperation,
  handle: number,
  owner?: CommandCalls,
): Promise<number> {
  return integer.parse(await posix(operation, handle, owner));
}
/**
 * Runs a call that opens something under `root` and returns its new handle, or -1 when the
 * open failed. `build` receives the handle id the result is stored under.
 */
export async function posixOpen(
  root: string,
  build: (handle: number) => PosixOperation,
  owner?: CommandCalls,
): Promise<number> {
  const handle = lanesOf(owner).allocate();
  const operation = build(handle);
  const { value } = await (owner ?? commandLanes()).run(root, operation);
  return created(operation, value) ? handle : -1;
}
/** A new owner for one user's calls, cancelled together. */
export function commandCallOwner(): PosixCallOwner {
  return new PosixCallOwner(commandLanes());
}
/** Tests only: later calls use a short deadline and other caps. Returns the restore. */
export function useCommandCallDeadline(
  deadlineMs: number,
  limits: Partial<Omit<PosixLimits, "deadlineMs">> = {},
): () => void {
  return commandLanes().configure({ ...limits, deadlineMs });
}
/** Resolves once nothing abandoned under `root` can still land. */
export function commandRootSettled(root: string): Promise<void> {
  if (process.platform === "win32") return Promise.resolve();
  return commandLanes().settled(root);
}

/** The fstat fields command discovery and the skill library read. */
export interface CommandStat {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
const fileType = 0o170000;
function commandStat(raw: PosixStat): CommandStat {
  const type = raw.mode & fileType;
  return {
    ...raw,
    isFile: () => type === 0o100000,
    isDirectory: () => type === 0o040000,
    isSymbolicLink: () => type === 0o120000,
  };
}

// Plain descriptor I/O runs on the root's thread too, never on the shared file thread pool: a
// read stuck on a cloud placeholder fails at its deadline instead of starving the daemon.
const windows = {
  stat: promisify(fstat),
  close: promisify(close),
  sync: promisify(fsync),
  chmod: promisify(fchmod),
};
export async function statCommandFd(fd: number, owner?: CommandCalls): Promise<CommandStat> {
  if (process.platform === "win32") return windows.stat(fd);
  return commandStat(PosixStat.parse(await posix({ op: "fstat", fd }, fd, owner)));
}
/** Reads up to `length` bytes at `position` (null: the fd's offset) into `buffer`; 0 at the end. */
export async function readCommandFd(
  fd: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number | null,
  owner?: CommandCalls,
): Promise<number> {
  if (process.platform === "win32")
    return new Promise((accept, reject) =>
      read(fd, buffer, offset, length, position, (error, bytes) =>
        error ? reject(error) : accept(bytes),
      ),
    );
  const size = Math.min(length, posixChunkLimit);
  if (size <= 0) return 0;
  const value = await posix({ op: "read", fd, length: size, position }, fd, owner);
  const bytes = bytesValue.parse(value);
  buffer.set(bytes.subarray(0, size), offset);
  return bytes.length;
}
/** Writes up to `length` bytes of `buffer` from `offset` at `position`; returns bytes written. */
export async function writeCommandFd(
  fd: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number,
  owner?: CommandCalls,
): Promise<number> {
  if (process.platform === "win32")
    return new Promise((accept, reject) =>
      write(fd, buffer, offset, length, position, (error, bytes) =>
        error ? reject(error) : accept(bytes),
      ),
    );
  const data = buffer.slice(offset, offset + Math.min(length, posixChunkLimit));
  return posixInteger({ op: "write", fd, data, position }, fd, owner);
}
export async function syncCommandFd(fd: number, owner?: CommandCalls): Promise<void> {
  if (process.platform === "win32") return windows.sync(fd);
  await posix({ op: "fsync", fd }, fd, owner);
}
export async function chmodCommandFd(
  fd: number,
  mode: number,
  owner?: CommandCalls,
): Promise<void> {
  if (process.platform === "win32") return windows.chmod(fd, mode);
  await posix({ op: "chmod", fd, mode }, fd, owner);
}
/**
 * Gives a handle back at once. Its owning thread closes the descriptor, after any call of its
 * still running there; a thread that was abandoned closes everything it owns as it drains.
 */
export async function closeCommandFd(handle: number, owner?: CommandCalls): Promise<void> {
  if (process.platform === "win32") return windows.close(handle).catch(() => {});
  lanesOf(owner).close(handle);
}

// Path calls on a command root run on that root's thread too. `root` names the lane.
const nodePaths = { lstat, stat, realpath, readdir, mkdir, open };
export async function lstatCommandPath(
  root: string,
  path: string,
  owner?: CommandCalls,
): Promise<CommandStat> {
  if (process.platform === "win32") return nodePaths.lstat(path);
  const { value } = await (owner ?? commandLanes()).run(root, { op: "lstatPath", path });
  return commandStat(PosixStat.parse(value));
}
export async function statCommandPath(root: string, path: string): Promise<CommandStat> {
  if (process.platform === "win32") return nodePaths.stat(path);
  return commandStat(
    PosixStat.parse((await commandLanes().run(root, { op: "statPath", path })).value),
  );
}
export async function realCommandPath(root: string, path: string): Promise<string> {
  if (process.platform === "win32") return nodePaths.realpath(path);
  return textValue.parse((await commandLanes().run(root, { op: "realpath", path })).value);
}
export async function listCommandPath(
  root: string,
  path: string,
  limit: number,
): Promise<string[]> {
  if (process.platform === "win32") return (await nodePaths.readdir(path)).slice(0, limit);
  const { value } = await commandLanes().run(root, { op: "readdirPath", path, limit });
  return namesValue.parse(value);
}
export async function makeCommandPath(root: string, path: string): Promise<void> {
  if (process.platform === "win32") return void (await nodePaths.mkdir(path, { recursive: true }));
  await commandLanes().run(root, { op: "mkdirPath", path });
}
/** A whole regular file at `path`, never through a final link; `EFBIG` over `limit` bytes. */
export async function readCommandPath(root: string, path: string, limit: number): Promise<Buffer> {
  if (process.platform === "win32") {
    const handle = await nodePaths.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > limit)
        throw Object.assign(new Error("Not a file within its size limit"), { code: "EFBIG" });
      const bytes = await handle.readFile();
      if (bytes.length > limit)
        throw Object.assign(new Error("Not a file within its size limit"), { code: "EFBIG" });
      return bytes;
    } finally {
      await handle.close();
    }
  }
  const { value } = await commandLanes().run(root, { op: "readPathNoFollow", path, limit });
  return Buffer.from(bytesValue.parse(value));
}
