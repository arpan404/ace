import { setTimeout as delay } from "node:timers/promises";
import { processIdentity } from "./process-identity.ts";
import { systemListing } from "./process-listing.ts";

/*
 * Process trees by parent pid, for stops that must reach every process a child started,
 * including ones that left its process group (setsid, `detached`, a shell's `&` with job
 * control). A group signal never reaches those, and once their parent exits the kernel hands
 * them to init (on Linux, to the nearest subreaper), so a tree is captured while it is still
 * connected, before anything is signalled. Linux and macOS only: Windows contains trees in job
 * objects instead.
 */

const tableLimit = 4_194_304;
/** The most members one capture walks: a fork bomb under a provider must not stall a stop. */
const captureLimit = 4_096;

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
/** What a capture saw: the member, the parent it had then and its process group. */
export type CapturedMember = TreeMember & { parent: number; group: number };
/** The kernel's identity of a live process. */
export type LiveIdentity = { start: string; group: number };

export type TreeIo = {
  platform: NodeJS.Platform;
  /** The direct children of `pid`, read synchronously: a shutdown captures its tree before any
   * of its own stop handlers can signal a member. */
  children(pid: number): number[];
  /** The identity of a running process; undefined once it is gone, a zombie included. */
  identity(pid: number): LiveIdentity | undefined;
  signal(pid: number, signal: NodeJS.Signals): void;
  wait(milliseconds: number): Promise<void>;
};

export const systemTreeIo: TreeIo = {
  platform: process.platform,
  children: (pid) => systemListing.children(pid),
  identity(pid) {
    const identity = processIdentity(pid);
    if (!identity || systemListing.zombie(pid)) return undefined;
    return { start: identity.start, group: identity.group };
  },
  signal: (pid, signal) => process.kill(pid, signal),
  wait: (milliseconds) => delay(milliseconds),
};

/** Whether this platform finds trees by parent pid. */
export function capturesTrees(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

/**
 * Every live process below `roots` with its start identity, parents before children. Work
 * follows the size of the tree, not of the machine. A process that ends while the tree is
 * read is left out; it needs no stopping.
 */
export function captureDescendants(
  roots: readonly number[],
  io: TreeIo = systemTreeIo,
): CapturedMember[] {
  if (!roots.length || !capturesTrees(io.platform)) return [];
  const members: CapturedMember[] = [];
  const seen = new Set<number>(roots);
  const queue = [...roots];
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    for (const pid of io.children(parent)) {
      if (seen.has(pid) || members.length >= captureLimit) continue;
      seen.add(pid);
      const identity = readIdentity(io, pid);
      if (!identity) continue;
      members.push({ pid, start: identity.start, parent, group: identity.group });
      queue.push(pid);
    }
  }
  return members;
}

function readIdentity(io: TreeIo, pid: number): LiveIdentity | undefined {
  try {
    return io.identity(pid);
  } catch {
    // Unreadable (another user's process): never ours to signal.
    return undefined;
  }
}

/** The live identity of a process, as a member to stop, or undefined once it is gone. */
export function memberOf(pid: number, io: TreeIo = systemTreeIo): TreeMember | undefined {
  const identity = readIdentity(io, pid);
  return identity ? { pid, start: identity.start } : undefined;
}

/** The captured members that are still the same running process. */
export function liveMembers(members: readonly TreeMember[], io: TreeIo = systemTreeIo) {
  return members.filter((member) => readIdentity(io, member.pid)?.start === member.start);
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
