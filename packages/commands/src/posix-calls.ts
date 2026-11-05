import { close, fchmod, fstat, fsync, read, write } from "node:fs";
import { promisify } from "node:util";
import { z } from "zod";
import type { PosixLanes, PosixLimits } from "./posix-lanes.ts";
import { PosixCallOwner } from "./posix-owner.ts";
import { posixWorkerLanes } from "./posix-worker-client.ts";
import { PosixStat, posixChunkLimit, type PosixOperation, type PosixValue } from "./posix-wire.ts";

/** Runs calls for whoever is asking; an owner's calls stop when it is cancelled. */
export interface CommandCalls {
  run(
    root: string,
    operation: PosixOperation,
    options?: { executor?: number },
  ): Promise<{ value: PosixValue; executor: number }>;
  /** The same lanes without cancellation, for releasing what these calls opened. */
  cleanup(): CommandCalls;
}

// Every POSIX call runs on a worker thread of the root its descriptor was opened under: a stalled
// network, FUSE or cloud mount blocks that root's thread, never the daemon's event loop, its
// file thread pool, or another root. Descriptors opened outside a resolved root share one lane.
let lanes: PosixLanes | undefined;
const descriptorRoots = new Map<number, string>();
const sharedRoot = "";
export const rootOf = (fd: number) => descriptorRoots.get(fd) ?? sharedRoot;
export const commandLanes = () => (lanes ??= posixWorkerLanes());
/** Everything later opened beneath `fd` runs on `root`'s own thread. */
export function assignRoot(fd: number, root: string): void {
  descriptorRoots.set(fd, root);
}
const integer = z.number().int();

export async function posix(
  operation: PosixOperation,
  fd: number,
  owner?: CommandCalls,
): Promise<PosixValue> {
  return (await (owner ?? commandLanes()).run(rootOf(fd), operation)).value;
}
export async function posixInteger(
  operation: PosixOperation,
  fd: number,
  owner?: CommandCalls,
): Promise<number> {
  return integer.parse(await posix(operation, fd, owner));
}
/** Opens a descriptor under `parent`'s root; the new descriptor stays on that root. */
export async function posixOpen(
  operation: PosixOperation,
  parent: number,
  owner?: CommandCalls,
): Promise<number> {
  const fd = await posixInteger(operation, parent, owner);
  if (fd >= 0) descriptorRoots.set(fd, rootOf(parent));
  return fd;
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
  const bytes = z.instanceof(Uint8Array).parse(value);
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
 * Hands `fd` back. The close runs on its root's thread once no call that names it is still
 * running natively, so a cancelled or abandoned call can never act on a reused number. It is
 * never refused; callers don't wait for it.
 */
export async function closeCommandFd(fd: number): Promise<void> {
  if (process.platform === "win32") return windows.close(fd).catch(() => {});
  commandLanes().close(rootOf(fd), fd);
}
