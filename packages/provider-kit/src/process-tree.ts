import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { processIdentity } from "./process-identity.ts";

/*
 * Process trees by parent pid, for stops that must reach every process a child started,
 * including ones that left its process group (setsid, `detached`, a shell's `&` with job
 * control). A group signal never reaches those, and once their parent exits the kernel hands
 * them to init, so the tree is captured while it is still connected, before anything is
 * signalled. Linux and macOS only: Windows contains trees in job objects instead.
 */

const tableLimit = 4_194_304;

/** `ps -A -o pid=,ppid=`: each process's parent. Malformed rows are skipped. */
export function parseProcessParents(text: string): Map<number, number> {
  if (text.length > tableLimit) throw new Error("Process table exceeds limit");
  const parents = new Map<number, number>();
  for (const line of text.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/);
    const child = Number(pid);
    const parent = Number(ppid);
    if (Number.isSafeInteger(child) && child > 0 && Number.isSafeInteger(parent) && parent >= 0)
      parents.set(child, parent);
  }
  return parents;
}

/** Every process below `roots` in the parent table, roots excluded, parents before children. */
export function descendantsOf(
  parents: ReadonlyMap<number, number>,
  roots: readonly number[],
): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, parent] of parents) {
    if (pid === parent) continue;
    const siblings = children.get(parent);
    if (siblings) siblings.push(pid);
    else children.set(parent, [pid]);
  }
  const seen = new Set<number>(roots);
  const found: number[] = [];
  const queue = [...roots];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** A captured process: its pid and the kernel's start identity, so a reused pid never matches. */
export type TreeMember = { pid: number; start: string };

export type TreeIo = {
  platform: NodeJS.Platform;
  /**
   * The visible process table as `pid ppid` rows, read synchronously: a shutdown captures
   * its tree before any of its own stop handlers can signal a member.
   */
  table(): string;
  /** The kernel start identity of a live process, or undefined once it is gone. */
  identity(pid: number): string | undefined;
  signal(pid: number, signal: NodeJS.Signals): void;
  wait(milliseconds: number): Promise<void>;
};

/** ps by absolute path: a daemon may run with an empty or foreign PATH. */
function psPath(): string {
  for (const path of ["/bin/ps", "/usr/bin/ps"]) if (existsSync(path)) return path;
  return "ps";
}

export const systemTreeIo: TreeIo = {
  platform: process.platform,
  table: () =>
    execFileSync(psPath(), ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      maxBuffer: tableLimit,
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  identity: (pid) => processIdentity(pid)?.start,
  signal: (pid, signal) => process.kill(pid, signal),
  wait: (milliseconds) => delay(milliseconds),
};

/** Whether this platform finds trees by parent pid. */
export function capturesTrees(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

/**
 * Every live process below `roots` with its start identity. A process that ends while the
 * table is read is left out; it needs no stopping.
 */
export function captureDescendants(
  roots: readonly number[],
  io: TreeIo = systemTreeIo,
): TreeMember[] {
  if (!roots.length || !capturesTrees(io.platform)) return [];
  const members: TreeMember[] = [];
  for (const pid of descendantsOf(parseProcessParents(io.table()), roots)) {
    const start = readIdentity(io, pid);
    if (start !== undefined) members.push({ pid, start });
  }
  return members;
}

function readIdentity(io: TreeIo, pid: number): string | undefined {
  try {
    return io.identity(pid);
  } catch {
    // Unreadable (another user's process): never ours to signal.
    return undefined;
  }
}

/** The captured members that are still the same running process. */
export function liveMembers(members: readonly TreeMember[], io: TreeIo = systemTreeIo) {
  return members.filter((member) => readIdentity(io, member.pid) === member.start);
}

/**
 * Stop the captured members still running: SIGTERM, then SIGKILL after `graceMs`. Each is
 * signalled only while its identity still matches. Resolves with any that survived both.
 */
export async function stopMembers(
  members: readonly TreeMember[],
  graceMs: number,
  io: TreeIo = systemTreeIo,
): Promise<TreeMember[]> {
  const signal = (targets: readonly TreeMember[], name: NodeJS.Signals) => {
    for (const member of liveMembers(targets, io))
      try {
        io.signal(member.pid, name);
      } catch {
        /* It ended between the check and the signal. */
      }
  };
  const settle = async (milliseconds: number) => {
    for (let waited = 0; waited < milliseconds && liveMembers(members, io).length; waited += 25)
      await io.wait(25);
  };
  if (!liveMembers(members, io).length) return [];
  signal(members, "SIGTERM");
  await settle(graceMs);
  signal(members, "SIGKILL");
  await settle(1_000);
  return liveMembers(members, io);
}
