import { setTimeout as delay } from "node:timers/promises";
import { systemListing, type ProcessListing } from "./process-listing.ts";
import { signalMember, systemPidFds, type PidFds } from "./process-signal.ts";

/*
 * Process trees by parent pid, for stops that must reach every process a child started,
 * including ones that left its process group (setsid, `detached`, a shell's `&` with job
 * control). A group signal never reaches those, and once their parent exits the kernel hands
 * them to init (on Linux, to the nearest subreaper), so a tree is captured while it is still
 * connected, before anything is signalled. Linux and macOS only: Windows contains trees in job
 * objects instead.
 *
 * What is signalled is decided by evidence: a pid with the kernel start time it had when it
 * was captured. A capture takes a child's start from the same kernel read as its parent link,
 * and keeps it only while the parent is still the process it walked from. Every signal is
 * checked against that start on its own, just before it is sent (`process-signal.ts`).
 */

const tableLimit = 4_194_304;
/**
 * The most members one capture walks. A capture that reaches it says so (`truncated`): a stop
 * must not report a tree as ended when it never saw all of it.
 */
export const captureLimit = 16_384;

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
/** A running process, from one kernel read: start, parent and group. */
export type LiveIdentity = { start: string; parent: number; group: number };

export type TreeIo = {
  platform: NodeJS.Platform;
  /** A children reader for one walk (see `ProcessListing.lister`). */
  lister(): (pid: number) => number[];
  /** A running process's identity; undefined once it is gone, a zombie included. */
  identity(pid: number): LiveIdentity | undefined;
  /** kill(2) by pid: only ever called through `signalMember`'s checks. */
  kill(pid: number, signal: NodeJS.Signals): void;
  /** Linux pidfds, where available: a reused pid can't receive a signal at all. */
  pidfd?: PidFds | undefined;
  wait(milliseconds: number): Promise<void>;
};

/** The tree seam over a listing. */
export function treeIo(listing: ProcessListing): TreeIo {
  return {
    platform: listing.platform,
    lister: () => listing.lister(),
    identity(pid) {
      const info = listing.info(pid);
      return info && !info.zombie
        ? { start: info.start, parent: info.parent, group: info.group }
        : undefined;
    },
    kill: (pid, signal) => process.kill(pid, signal),
    pidfd: systemPidFds(listing.platform),
    wait: (milliseconds) => delay(milliseconds),
  };
}

export const systemTreeIo: TreeIo = treeIo(systemListing);

/** Whether this platform finds trees by parent pid. */
export function capturesTrees(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

/** A capture: what it found, and whether it stopped at its limit before the end. */
export type Capture = { members: CapturedMember[]; truncated: boolean };

/**
 * Every live process below `roots` with its start identity, parents before children. Work
 * follows the size of the tree, not of the machine. A child is kept only when its own parent
 * link (read with its start) names the parent being walked, and only while that parent is still
 * the process the walk reached: a pid reused by an unrelated process during the walk is never
 * taken for a member.
 */
export function captureTree(
  roots: readonly number[],
  io: TreeIo = systemTreeIo,
  limit = captureLimit,
): Capture {
  if (!roots.length || !capturesTrees(io.platform)) return { members: [], truncated: false };
  const children = io.lister();
  const members: CapturedMember[] = [];
  const seen = new Set<number>(roots);
  const queue: TreeMember[] = [];
  for (const pid of roots) {
    const identity = readIdentity(io, pid);
    if (identity) queue.push({ pid, start: identity.start });
  }
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    const found: CapturedMember[] = [];
    for (const pid of children(parent.pid)) {
      if (seen.has(pid)) continue;
      const identity = readIdentity(io, pid);
      if (!identity || identity.parent !== parent.pid) continue;
      found.push({ pid, start: identity.start, parent: parent.pid, group: identity.group });
    }
    // The list was the children of whoever held the parent's pid: only ours if it still does.
    if (readIdentity(io, parent.pid)?.start !== parent.start) continue;
    for (const member of found) {
      if (members.length >= limit) return { members, truncated: true };
      seen.add(member.pid);
      members.push(member);
      queue.push(member);
    }
  }
  return { members, truncated: false };
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

/** Signal one member, checked on its own just before the signal goes. */
export function signalTreeMember(
  member: TreeMember,
  signal: NodeJS.Signals,
  io: TreeIo = systemTreeIo,
): "sent" | "gone" {
  return signalMember(member, signal, {
    start: (pid) => readIdentity(io, pid)?.start,
    kill: (pid, name) => io.kill(pid, name),
    pidfd: io.pidfd,
  });
}

/**
 * Stop the captured members still running: SIGTERM, then SIGKILL after `graceMs`. Each signal
 * is checked against its member's start on its own, just before it goes, never for a batch.
 * Waits end at `deadline` (a `performance.now()` time) when one is given. Resolves with the
 * members still running.
 */
export async function stopMembers(
  members: readonly TreeMember[],
  graceMs: number,
  io: TreeIo = systemTreeIo,
  deadline = Number.POSITIVE_INFINITY,
): Promise<TreeMember[]> {
  const signal = (name: NodeJS.Signals) => {
    for (const member of members) signalTreeMember(member, name, io);
  };
  const settle = async (milliseconds: number) => {
    for (
      let waited = 0;
      waited < milliseconds && performance.now() < deadline && liveMembers(members, io).length;
      waited += 25
    )
      await io.wait(25);
  };
  if (!liveMembers(members, io).length) return [];
  signal("SIGTERM");
  await settle(graceMs);
  signal("SIGKILL");
  await settle(1_000);
  return liveMembers(members, io);
}
