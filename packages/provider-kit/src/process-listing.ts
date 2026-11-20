import { closeSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { openLibrary, type NativeFunction } from "./bun-ffi.ts";

/*
 * What the kernel says about processes, read in ways whose cost follows what is asked: one
 * process's children, its parent, its environment. Linux reads /proc; macOS asks libproc and
 * the KERN_PROCARGS2 sysctl through bun:ffi. Every reader returns nothing, never throws, for a
 * process that ended or that this user may not inspect: nothing here is a reason to signal.
 *
 * A process's environment is the one it was started with. Linux shows it for every process of
 * the same user. macOS shows it for the same user's processes too, except Apple's platform
 * binaries (/bin/sh, zsh, bash, sleep and the rest of the OS): the kernel returns their
 * arguments with the environment stripped (checked on macOS 27.0.1; `ps -E` is the same call).
 */

const environLimit = 1_048_576;

/** `/proc/<pid>/task/<tid>/children`: space-separated pids. */
export function parseChildList(text: string): number[] {
  const pids: number[] = [];
  for (const word of text.trim().split(/\s+/)) {
    const pid = Number(word);
    if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/** `/proc/<pid>/environ`: NUL-separated `NAME=value` strings. */
export function parseEnviron(bytes: Uint8Array): string[] {
  return Buffer.from(bytes).toString("utf8").split("\0").filter(Boolean);
}

/**
 * macOS KERN_PROCARGS2: argc (int32), the executable path, NUL padding, argc argument strings,
 * then the environment strings, ended by an empty string. Malformed input yields what parsed.
 */
export function parseProcArgs2(bytes: Uint8Array): { argv: string[]; env: string[] } {
  if (bytes.length < 4) return { argv: [], env: [] };
  const buffer = Buffer.from(bytes);
  const argc = buffer.readInt32LE(0);
  let at = buffer.indexOf(0, 4);
  if (at < 0) return { argv: [], env: [] };
  while (at < buffer.length && buffer[at] === 0) at++;
  const take = () => {
    const end = buffer.indexOf(0, at);
    const value = buffer.toString("utf8", at, end < 0 ? buffer.length : end);
    at = end < 0 ? buffer.length : end + 1;
    return value;
  };
  const argv: string[] = [];
  for (let index = 0; index < argc && at < buffer.length; index++) argv.push(take());
  const env: string[] = [];
  while (at < buffer.length) {
    const value = take();
    if (!value) break;
    env.push(value);
  }
  return { argv, env };
}

/** `/proc/<pid>/stat` past the command: its state, parent and process group. */
export function parseLinuxStat(text: string): { state: string; ppid: number; group: number } {
  const end = text.lastIndexOf(")");
  if (end < 1) throw new Error("Invalid kernel process stat");
  const [state = "", ppid, group] = text
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  return { state, ppid: Number(ppid), group: Number(group) };
}

export interface ProcessListing {
  platform: NodeJS.Platform;
  /** The direct children of `pid`; empty once it is gone. */
  children(pid: number): number[];
  /** Every process this user can see. */
  all(): number[];
  /** Its parent's pid, or undefined once it is gone. */
  parent(pid: number): number | undefined;
  /** Its start environment, or undefined when hidden (another user, an Apple binary) or gone. */
  environment(pid: number): string[] | undefined;
  /** Whether it has exited and waits for its parent to reap it: gone, for every sweep. */
  zombie(pid: number): boolean;
}

/**
 * One scratch buffer for every read here: a sweep reads every process's environment, and a
 * fresh megabyte each would be gigabytes of garbage. Callers copy what they keep.
 */
let scratch = Buffer.alloc(65_536);
function room(size: number): Buffer {
  if (scratch.length < size) scratch = Buffer.alloc(size);
  return scratch;
}

/** Up to `limit` bytes of a file, copied out of the scratch buffer. */
function readBounded(path: string, limit: number): Uint8Array | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    let length = 0;
    while (length < limit) {
      if (length === scratch.length) {
        const grown = Buffer.alloc(Math.min(limit, scratch.length * 2));
        scratch.copy(grown, 0, 0, length);
        scratch = grown;
      }
      const read = readSync(
        descriptor,
        scratch,
        length,
        Math.min(limit, scratch.length) - length,
        null,
      );
      if (read === 0) break;
      length += read;
    }
    return Buffer.from(scratch.subarray(0, length));
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function linuxChildren(pid: number): number[] {
  let tasks: string[];
  try {
    tasks = readdirSync(`/proc/${pid}/task`);
  } catch {
    return [];
  }
  const children: number[] = [];
  let listed = false;
  for (const task of tasks) {
    const text = readBounded(`/proc/${pid}/task/${task}/children`, 65_536);
    if (!text) continue;
    listed = true;
    children.push(...parseChildList(Buffer.from(text).toString("utf8")));
  }
  if (listed) return children;
  // A kernel without CONFIG_PROC_CHILDREN: every process's parent, from its stat.
  return linuxAll().filter((child) => linuxParent(child) === pid);
}

function linuxAll(): number[] {
  try {
    return readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .map(Number);
  } catch {
    return [];
  }
}

function linuxParent(pid: number): number | undefined {
  try {
    return parseLinuxStat(readFileSync(`/proc/${pid}/stat`, "utf8")).ppid;
  } catch {
    return undefined;
  }
}

type Darwin = Readonly<
  Record<"proc_listchildpids" | "proc_listallpids" | "proc_pidinfo" | "sysctl", NativeFunction>
>;
let darwin: Darwin | undefined;
function darwinApi(): Darwin {
  if (darwin) return darwin;
  const proc = openLibrary("/usr/lib/libproc.dylib", {
    proc_listchildpids: { args: ["i32", "ptr", "i32"], returns: "i32" },
    proc_listallpids: { args: ["ptr", "i32"], returns: "i32" },
    proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
  }).symbols;
  const system = openLibrary("/usr/lib/libSystem.B.dylib", {
    sysctl: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "u64"], returns: "i32" },
  }).symbols;
  darwin = { ...proc, sysctl: system.sysctl };
  return darwin;
}

function darwinList(fill: (buffer: Int32Array) => unknown): number[] {
  for (let size = 256; size <= 65_536; size *= 4) {
    const buffer = new Int32Array(size);
    const count = Number(fill(buffer));
    if (!Number.isSafeInteger(count) || count < 0) return [];
    if (count < size) return [...buffer.subarray(0, count)].filter((pid) => pid > 0);
  }
  return [];
}

/** PROC_PIDTBSDINFO: proc_bsdinfo, with pbi_status at 4 and pbi_ppid (after pbi_pid) at 16. */
function darwinInfo(pid: number): { status: number; ppid: number } | undefined {
  const buffer = Buffer.alloc(136);
  if (darwinApi().proc_pidinfo(pid, 3, 0n, buffer, buffer.length) !== buffer.length)
    return undefined;
  return { status: buffer.readUInt32LE(4), ppid: buffer.readUInt32LE(16) };
}
/** SZOMB in <sys/proc.h>. */
const darwinZombie = 5;

function darwinEnvironment(pid: number): string[] | undefined {
  // CTL_KERN, KERN_PROCARGS2: asked for its size first, then read into the scratch buffer.
  const name = new Int32Array([1, 49, pid]);
  const size = new BigUint64Array(1);
  if (darwinApi().sysctl(name, 3, null, size, null, 0n) !== 0) return undefined;
  const needed = Math.min(Number(size[0]), environLimit);
  const buffer = room(needed);
  size[0] = BigInt(needed);
  if (darwinApi().sysctl(name, 3, buffer, size, null, 0n) !== 0) return undefined;
  return parseProcArgs2(buffer.subarray(0, Number(size[0]))).env;
}

export const systemListing: ProcessListing = {
  platform: process.platform,
  children(pid) {
    try {
      if (process.platform === "linux") return linuxChildren(pid);
      if (process.platform === "darwin")
        return darwinList((buffer) =>
          darwinApi().proc_listchildpids(pid, buffer, buffer.byteLength),
        );
    } catch {
      /* Unreadable: no children to act on. */
    }
    return [];
  },
  all() {
    try {
      if (process.platform === "linux") return linuxAll();
      if (process.platform === "darwin")
        return darwinList((buffer) => darwinApi().proc_listallpids(buffer, buffer.byteLength));
    } catch {
      /* Unreadable: nothing found. */
    }
    return [];
  },
  parent(pid) {
    try {
      if (process.platform === "linux") return linuxParent(pid);
      if (process.platform === "darwin") return darwinInfo(pid)?.ppid;
    } catch {
      /* Gone or unreadable. */
    }
    return undefined;
  },
  environment(pid) {
    try {
      if (process.platform === "linux") {
        const bytes = readBounded(`/proc/${pid}/environ`, environLimit);
        return bytes ? parseEnviron(bytes) : undefined;
      }
      if (process.platform === "darwin") return darwinEnvironment(pid);
    } catch {
      /* Hidden or gone. */
    }
    return undefined;
  },
  zombie(pid) {
    try {
      if (process.platform === "linux")
        return parseLinuxStat(readFileSync(`/proc/${pid}/stat`, "utf8")).state === "Z";
      if (process.platform === "darwin") return darwinInfo(pid)?.status === darwinZombie;
    } catch {
      /* Gone. */
    }
    return false;
  },
};

/** `pid` and every ancestor up to init: the processes a sweep must never signal. */
export function lineage(pid: number, listing: ProcessListing = systemListing): Set<number> {
  const found = new Set<number>();
  for (let next: number | undefined = pid; next !== undefined && next > 1;) {
    if (found.has(next)) break;
    found.add(next);
    next = listing.parent(next);
  }
  return found;
}

/** `/proc/<pid>/cgroup` on the unified hierarchy: the `0::` line's path. */
export function parseCgroupPath(text: string): string | undefined {
  const line = text.split("\n").find((entry) => entry.startsWith("0::"));
  const path = line?.slice(3).trim();
  return path?.startsWith("/") ? path : undefined;
}

/**
 * Linux: the cgroup `pid` runs in and its members, read from cgroup v2. A service manager's
 * unit cgroup holds every process the unit started, whatever group, session or parent it has.
 */
export function cgroupOf(
  pid: number | "self" = "self",
): { path: string; unit: string } | undefined {
  try {
    const path = parseCgroupPath(readFileSync(`/proc/${pid}/cgroup`, "utf8"));
    if (!path) return undefined;
    return { path, unit: path.slice(path.lastIndexOf("/") + 1) };
  } catch {
    return undefined;
  }
}

export function cgroupMembers(path: string): number[] {
  if (!path.startsWith("/") || path.includes("..")) return [];
  const text = readBounded(`/sys/fs/cgroup${path}/cgroup.procs`, 1_048_576);
  return text ? parseChildList(Buffer.from(text).toString("utf8")) : [];
}
