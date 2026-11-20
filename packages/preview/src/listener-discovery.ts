import { readdir, readlink } from "node:fs/promises";
import { probeOutput } from "@ace/provider-kit/process";
import { readBoundedText } from "./bounded-file.ts";
import {
  joinProcListeners,
  parseLsofCwds,
  parseLsofListeners,
  parseProcessParents,
  parseNetstatListeners,
  parseProcSockets,
  type Listener,
} from "./listeners.ts";

/*
 * The thin OS shell around `listeners.ts`: which processes listen on TCP, their parents and
 * their working directories. macOS asks lsof and ps; Linux reads /proc. Every edge is injected
 * so callers can stand in for the OS.
 */

export interface ProcessIo {
  platform: NodeJS.Platform;
  /** Runs a tool; exit codes 0 and 1 (lsof's "nothing matched") are both answers. */
  run(command: string, args: readonly string[]): Promise<{ stdout: string; code: number | null }>;
  readText(path: string): Promise<string>;
  list(path: string): Promise<string[]>;
  link(path: string): Promise<string>;
}

export const systemProcessIo: ProcessIo = {
  platform: process.platform,
  run: (command, args) => probeOutput(command, args, { maxBytes: 4_194_304, timeoutMs: 5000 }),
  readText: (path) => readBoundedText(path),
  list: (path) => readdir(path),
  link: (path) => readlink(path),
};

const answered = (code: number | null) => code === 0 || code === 1;
const missing = () => "";

async function procPids(io: ProcessIo): Promise<number[]> {
  return (await io.list("/proc")).filter((name) => /^\d+$/.test(name)).map(Number);
}

/** Every TCP listener this user can see, with the process that holds it. */
export async function discoverListeners(io: ProcessIo = systemProcessIo): Promise<Listener[]> {
  if (io.platform === "darwin") {
    const output = await io.run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]);
    if (!answered(output.code)) throw new Error("lsof listener discovery failed");
    return parseLsofListeners(output.stdout);
  }
  if (io.platform === "linux") {
    const tables = await Promise.all([
      io.readText("/proc/net/tcp"),
      io.readText("/proc/net/tcp6").catch(missing),
    ]);
    const rows = parseProcSockets(tables.join("\n"));
    if (!rows.length) return [];
    const wanted = new Set(rows.map((row) => row.inode));
    const inodes = new Map<number, Set<string>>();
    for (const pid of await procPids(io)) {
      // Another user's descriptors are unreadable; those processes are never ours anyway.
      const fds = await io.list(`/proc/${pid}/fd`).catch((): string[] => []);
      for (const fd of fds) {
        const target = await io.link(`/proc/${pid}/fd/${fd}`).catch(missing);
        const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
        if (!inode || !wanted.has(inode)) continue;
        const held = inodes.get(pid) ?? new Set<string>();
        held.add(inode);
        inodes.set(pid, held);
      }
    }
    return joinProcListeners(rows, inodes);
  }
  throw new Error(`Unsupported preview discovery platform: ${io.platform}`);
}

/** One pass over the machine's TCP listeners: every listening port, and the ones `pids` hold. */
export interface ListeningScan {
  listening: Set<number>;
  owned: Set<number>;
}

/**
 * Every TCP port the machine listens on and which of them `pids` hold, from one read of the OS
 * tables: one `lsof` on macOS, one `netstat` on Windows, and on Linux the socket tables plus only
 * those processes' descriptors (never every process's, as `discoverListeners` walks).
 */
export async function scanListeningPorts(
  pids: readonly number[],
  io: ProcessIo = systemProcessIo,
): Promise<ListeningScan> {
  const wanted = new Set(pids);
  const split = (listeners: readonly Listener[]): ListeningScan => ({
    listening: new Set(listeners.map((listener) => listener.port)),
    owned: new Set(
      listeners.filter((listener) => wanted.has(listener.pid)).map((listener) => listener.port),
    ),
  });
  if (io.platform === "linux") {
    const tables = await Promise.all([
      io.readText("/proc/net/tcp"),
      io.readText("/proc/net/tcp6").catch(missing),
    ]);
    const rows = parseProcSockets(tables.join("\n"));
    const inodes = new Set(rows.map((row) => row.inode));
    const held = new Map<number, Set<string>>();
    for (const pid of wanted) {
      // A process that has gone holds nothing; the daemon's own descriptors are always readable.
      const fds = await io.list(`/proc/${pid}/fd`).catch((): string[] => []);
      const own = new Set<string>();
      for (const fd of fds) {
        const target = await io.link(`/proc/${pid}/fd/${fd}`).catch(missing);
        const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
        if (inode && inodes.has(inode)) own.add(inode);
      }
      held.set(pid, own);
    }
    return {
      listening: new Set(rows.map((row) => row.port)),
      owned: new Set(joinProcListeners(rows, held).map((listener) => listener.port)),
    };
  }
  if (io.platform === "darwin") {
    const output = await io.run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]);
    if (!answered(output.code)) throw new Error("lsof listener discovery failed");
    return split(parseLsofListeners(output.stdout));
  }
  if (io.platform === "win32") {
    const output = await io.run("netstat", ["-a", "-n", "-o"]);
    if (output.code !== 0) throw new Error("netstat listener discovery failed");
    return split(parseNetstatListeners(output.stdout));
  }
  throw new Error(`Unsupported listener discovery platform: ${io.platform}`);
}

/** Each visible process's parent. */
export async function processParents(
  io: ProcessIo = systemProcessIo,
): Promise<Map<number, number>> {
  const output = await io.run("ps", ["-A", "-o", "pid=,ppid="]);
  if (output.code !== 0) throw new Error("ps process listing failed");
  return parseProcessParents(output.stdout);
}

/** The working directories of `pids`; a process that ended or isn't ours is left out. */
export async function processCwds(
  pids: readonly number[],
  io: ProcessIo = systemProcessIo,
): Promise<Map<number, string>> {
  if (!pids.length) return new Map();
  if (io.platform === "linux") {
    const cwds = new Map<number, string>();
    for (const pid of pids) {
      const cwd = await io.link(`/proc/${pid}/cwd`).catch(missing);
      if (cwd) cwds.set(pid, cwd.replace(/ \(deleted\)$/, ""));
    }
    return cwds;
  }
  const output = await io.run("lsof", ["-nP", "-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"]);
  if (!answered(output.code)) throw new Error("lsof directory lookup failed");
  return parseLsofCwds(output.stdout);
}
