import { readdir, readlink } from "node:fs/promises";
import { probeOutput } from "@ace/provider-kit/process";
import { readBoundedText } from "./bounded-file.ts";
import {
  joinProcListeners,
  parseLsofCwds,
  parseLsofListeners,
  parseProcessParents,
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
