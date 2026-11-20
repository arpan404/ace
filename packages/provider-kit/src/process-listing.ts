import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { openLibrary, type NativeFunction } from "./bun-ffi.ts";
import { processIdentity } from "./process-identity.ts";

/*
 * What the kernel says about processes, read in ways whose cost follows what is asked: one
 * process's children, its identity, its environment. Linux reads /proc; macOS asks libproc and
 * the KERN_PROCARGS2 sysctl through bun:ffi. Every reader returns nothing, never throws, for a
 * process that ended or that this user may not inspect: nothing here is a reason to signal.
 *
 * A process's identity (start time), parent, group and state come from ONE kernel read
 * (`/proc/<pid>/stat`, one proc_pidinfo call), so a parent link and a start time always
 * describe the same process, even when its pid is reused around the read.
 *
 * A process's environment is the one it was started with. Linux shows it for every process of
 * the same user. macOS shows it for the same user's processes too, except Apple's platform
 * binaries (/bin/sh, zsh, bash, sleep and the rest of the OS): the kernel returns their
 * arguments with the environment stripped (checked on macOS 27.0.1; `ps -E` is the same call).
 */

const environLimit = 1_048_576;

/** One process, from one kernel read. `start` is the same string `processIdentity` gives. */
export type ProcessInfo = { start: string; parent: number; group: number; zombie: boolean };

/** `/proc/<pid>/task/<tid>/children`: space-separated pids. */
export function parseChildList(text: string): number[] {
  const pids: number[] = [];
  for (const word of text.trim().split(/\s+/)) {
    const pid = Number(word);
    if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/** NUL-separated strings: `/proc/<pid>/environ` and `/proc/<pid>/cmdline`. */
export function parseNulList(bytes: Uint8Array): string[] {
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

/** `/proc/<pid>/stat` past the command: state, parent, group and start ticks. */
export function parseLinuxStat(text: string): {
  state: string;
  ppid: number;
  group: number;
  ticks: string;
} {
  const end = text.lastIndexOf(")");
  if (end < 1) throw new Error("Invalid kernel process stat");
  const fields = text
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  const ticks = fields[19] ?? "";
  if (!/^\d+$/.test(ticks)) throw new Error("Invalid kernel process stat");
  return { state: fields[0] ?? "", ppid: Number(fields[1]), group: Number(fields[2]), ticks };
}

export interface ProcessListing {
  platform: NodeJS.Platform;
  /**
   * A children reader for one walk. Where the kernel keeps no per-process child list (Linux
   * without CONFIG_PROC_CHILDREN), the first call reads the process table once and every later
   * call of this reader answers from it.
   */
  lister(): (pid: number) => number[];
  /** Every process this user can see. */
  all(): number[];
  /** One kernel read of a process: start, parent, group, state. Undefined once it is gone. */
  info(pid: number): ProcessInfo | undefined;
  /** Its start environment, or undefined when hidden (another user, an Apple binary) or gone. */
  environment(pid: number): string[] | undefined;
  /** Its arguments, argv[0] first; macOS shows these even for platform binaries. */
  arguments(pid: number): string[] | undefined;
  /** Every process in process group `group`, whatever its parent or session now. */
  groupMembers(group: number): number[];
  /**
   * macOS: the kernel's unique id for the process, and the unique id of the process that
   * started it. Unique ids are never reused, and the parent's stays recorded after the process
   * is orphaned to launchd, so an orphan can be traced to the process that started it even if
   * it was never seen, runs an Apple binary and hides its environment. Elsewhere: undefined.
   */
  ancestry?(pid: number): { unique: string; parentUnique: string } | undefined;
}

/** What Linux's listing reads, so tests can stand in for /proc. */
export interface ProcFs {
  list(path: string): string[] | undefined;
  read(path: string, limit: number): Uint8Array | undefined;
}

/**
 * One scratch buffer for every read here: a sweep reads every process's environment, and a
 * fresh megabyte each would be gigabytes of garbage. Callers get a copy.
 */
let scratch = Buffer.alloc(65_536);
function room(size: number): Buffer {
  if (scratch.length < size) scratch = Buffer.alloc(size);
  return scratch;
}

export const systemProcFs: ProcFs = {
  list(path) {
    try {
      return readdirSync(path);
    } catch {
      return undefined;
    }
  },
  read(path, limit) {
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
  },
};

const text = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8");

/** Linux's listing over `proc` (the real /proc unless a test stands in). */
export function linuxListing(proc: ProcFs = systemProcFs): ProcessListing {
  let boot: string | undefined;
  const bootId = () => (boot ??= text(proc.read("/proc/sys/kernel/random/boot_id", 64))?.trim());
  const pids = () => (proc.list("/proc") ?? []).filter((name) => /^\d+$/.test(name)).map(Number);
  const info = (pid: number): ProcessInfo | undefined => {
    const stat = text(proc.read(`/proc/${pid}/stat`, 4_096));
    const id = bootId();
    if (stat === undefined || !id) return undefined;
    try {
      const parsed = parseLinuxStat(stat);
      return {
        start: `${id}:${parsed.ticks}`,
        parent: parsed.ppid,
        group: parsed.group,
        zombie: parsed.state === "Z",
      };
    } catch {
      return undefined;
    }
  };
  return {
    platform: "linux",
    lister() {
      let table: Map<number, number[]> | undefined;
      const fromTable = (pid: number) => {
        if (!table) {
          table = new Map();
          for (const child of pids()) {
            const parent = info(child)?.parent;
            if (parent === undefined) continue;
            const siblings = table.get(parent);
            if (siblings) siblings.push(child);
            else table.set(parent, [child]);
          }
        }
        return table.get(pid) ?? [];
      };
      let perTask: boolean | undefined;
      return (pid) => {
        if (perTask === false) return fromTable(pid);
        const tasks = proc.list(`/proc/${pid}/task`);
        if (!tasks) return [];
        const children: number[] = [];
        let listed = false;
        for (const task of tasks) {
          const list = text(proc.read(`/proc/${pid}/task/${task}/children`, 65_536));
          if (list === undefined) continue;
          listed = true;
          children.push(...parseChildList(list));
        }
        if (listed) {
          perTask = true;
          return children;
        }
        // A kernel without CONFIG_PROC_CHILDREN: the whole table, once for this walk.
        perTask = false;
        return fromTable(pid);
      };
    },
    all: pids,
    info,
    groupMembers: (group) => pids().filter((pid) => info(pid)?.group === group),
    environment(pid) {
      const bytes = proc.read(`/proc/${pid}/environ`, environLimit);
      return bytes ? parseNulList(bytes) : undefined;
    },
    arguments(pid) {
      const bytes = proc.read(`/proc/${pid}/cmdline`, 65_536);
      return bytes ? parseNulList(bytes) : undefined;
    },
  };
}

type Darwin = Readonly<
  Record<
    "proc_listchildpids" | "proc_listallpids" | "proc_listpgrppids" | "proc_pidinfo" | "sysctl",
    NativeFunction
  >
>;
let darwin: Darwin | undefined;
function darwinApi(): Darwin {
  if (darwin) return darwin;
  const proc = openLibrary("/usr/lib/libproc.dylib", {
    proc_listchildpids: { args: ["i32", "ptr", "i32"], returns: "i32" },
    proc_listpgrppids: { args: ["i32", "ptr", "i32"], returns: "i32" },
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

/** SZOMB in <sys/proc.h>. */
const darwinZombie = 5;

/**
 * PROC_PIDTBSDINFO: proc_bsdinfo in one call. pbi_status at 4, pbi_pid at 12, pbi_ppid at 16,
 * pbi_pgid at 100 and the start timeval at 120 and 128, as `processIdentity` reads them.
 */
function darwinInfo(pid: number): ProcessInfo | undefined {
  const buffer = Buffer.alloc(136);
  if (darwinApi().proc_pidinfo(pid, 3, 0n, buffer, buffer.length) !== buffer.length)
    return undefined;
  if (buffer.readUInt32LE(12) !== pid) return undefined;
  return {
    start: `${buffer.readBigUInt64LE(120)}:${buffer.readBigUInt64LE(128)}`,
    parent: buffer.readUInt32LE(16),
    group: buffer.readUInt32LE(100),
    zombie: buffer.readUInt32LE(4) === darwinZombie,
  };
}

function darwinProcArgs(pid: number): { argv: string[]; env: string[] } | undefined {
  // CTL_KERN, KERN_PROCARGS2: asked for its size first, then read into the scratch buffer.
  const name = new Int32Array([1, 49, pid]);
  const size = new BigUint64Array(1);
  if (darwinApi().sysctl(name, 3, null, size, null, 0n) !== 0) return undefined;
  const needed = Math.min(Number(size[0]), environLimit);
  const buffer = room(needed);
  size[0] = BigInt(needed);
  if (darwinApi().sysctl(name, 3, buffer, size, null, 0n) !== 0) return undefined;
  return parseProcArgs2(buffer.subarray(0, Number(size[0])));
}

/** Calls a native reader; a failure (a gone process, a refused call) is no answer. */
function quietly<T>(read: () => T, otherwise: T): T {
  try {
    return read();
  } catch {
    return otherwise;
  }
}

/** PROC_PIDUNIQIDENTIFIERINFO: p_uuid[16], then p_uniqueid and p_puniqueid (u64 each). */
function darwinAncestry(pid: number): { unique: string; parentUnique: string } | undefined {
  const buffer = Buffer.alloc(56);
  if (Number(darwinApi().proc_pidinfo(pid, 17, 0n, buffer, buffer.length)) < 32) return undefined;
  return {
    unique: buffer.readBigUInt64LE(16).toString(),
    parentUnique: buffer.readBigUInt64LE(24).toString(),
  };
}

export const darwinListing: ProcessListing = {
  platform: "darwin",
  lister: () => (pid) =>
    quietly(
      () => darwinList((buffer) => darwinApi().proc_listchildpids(pid, buffer, buffer.byteLength)),
      [],
    ),
  all: () =>
    quietly(
      () => darwinList((buffer) => darwinApi().proc_listallpids(buffer, buffer.byteLength)),
      [],
    ),
  info: (pid) => quietly(() => darwinInfo(pid), undefined),
  environment: (pid) => quietly(() => darwinProcArgs(pid)?.env, undefined),
  arguments: (pid) => quietly(() => darwinProcArgs(pid)?.argv, undefined),
  groupMembers: (group) =>
    quietly(
      () => darwinList((buffer) => darwinApi().proc_listpgrppids(group, buffer, buffer.byteLength)),
      [],
    ),
  ancestry: (pid) => quietly(() => darwinAncestry(pid), undefined),
};

/**
 * Windows: a process's identity is its creation time (`processIdentity`). Windows has no
 * process groups and never reparents; provider trees live in kill-on-close Job Objects, and the
 * inventory records each tree's members with their creation times, so a stop proves them by
 * those records rather than by walking parents here.
 */
export function windowsListing(
  identify: (pid: number) => { start: string } | undefined,
): ProcessListing {
  return {
    platform: "win32",
    lister: () => () => [],
    all: () => [],
    info(pid) {
      const identity = quietly(() => identify(pid), undefined);
      return identity && { start: identity.start, parent: 0, group: pid, zombie: false };
    },
    environment: () => undefined,
    arguments: () => undefined,
    groupMembers: () => [],
  };
}

const nothing: ProcessListing = {
  platform: process.platform,
  lister: () => () => [],
  all: () => [],
  info: () => undefined,
  environment: () => undefined,
  arguments: () => undefined,
  groupMembers: () => [],
};

export const systemListing: ProcessListing =
  process.platform === "linux"
    ? linuxListing()
    : process.platform === "darwin"
      ? darwinListing
      : process.platform === "win32"
        ? windowsListing((pid) => processIdentity(pid))
        : nothing;

/** `pid` and every ancestor up to init: the processes a sweep must never signal. */
export function lineage(pid: number, listing: ProcessListing = systemListing): Set<number> {
  const found = new Set<number>();
  for (let next: number | undefined = pid; next !== undefined && next > 1;) {
    if (found.has(next)) break;
    found.add(next);
    next = listing.info(next)?.parent;
  }
  return found;
}

/** `/proc/<pid>/cgroup` on the unified hierarchy: the `0::` line's path. */
export function parseCgroupPath(content: string): string | undefined {
  const line = content.split("\n").find((entry) => entry.startsWith("0::"));
  const path = line?.slice(3).trim();
  return path?.startsWith("/") ? path : undefined;
}

/**
 * Linux: the cgroup `pid` runs in, read from cgroup v2. A service manager's unit cgroup holds
 * every process the unit started, whatever group, session or parent it has.
 */
export function cgroupOf(
  pid: number | "self" = "self",
  proc: ProcFs = systemProcFs,
): { path: string; unit: string } | undefined {
  const content = text(proc.read(`/proc/${pid}/cgroup`, 65_536));
  const path = content === undefined ? undefined : parseCgroupPath(content);
  if (!path) return undefined;
  return { path, unit: path.slice(path.lastIndexOf("/") + 1) };
}

export function cgroupMembers(path: string, proc: ProcFs = systemProcFs): number[] {
  if (!path.startsWith("/") || path.includes("..")) return [];
  const content = text(proc.read(`/sys/fs/cgroup${path}/cgroup.procs`, 1_048_576));
  return content === undefined ? [] : parseChildList(content);
}
