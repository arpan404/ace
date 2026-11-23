import { setTimeout as delay } from "node:timers/promises";
import { systemListing, type ProcessListing } from "./process-listing.ts";
import { carriesGroupToken } from "./group-token.ts";
import {
  installGroupGuards,
  killGroup,
  locallyGuarded,
  signalOwnedMembers,
  unregisterGroup,
  type GroupGuard,
  type MemberGuard,
} from "./process-owner.ts";
import {
  captureTree,
  liveMembers,
  systemTreeIo,
  type TreeIo,
  type TreeMember,
} from "./process-tree.ts";
import {
  relaySignal,
  relaysSignals,
  serveRelayedSignals,
  type RelayedSignal,
} from "./signal-relay.ts";

/*
 * A process group ace started, signalled so that a signal never reaches a group ace doesn't own.
 *
 * While the leader is unreaped (running, or a zombie no one has waited for) its pid holds the
 * group id, so the group may be signalled by number: `pinned` is the leader's own exit not yet
 * heard, and the leader's pid still showing the start it had at spawn. Every signal sent then
 * first records the group's members and the leader's tree, with start times (and macOS unique
 * ids), re-checking the pin after the read.
 *
 * Once the leader is reaped its group id is free as soon as the group empties, and may then name
 * an unrelated group. From then on the number is never signalled, and nothing is taken from the
 * number alone. Signals go to members one by one (`signalTreeMember`: each checked against its
 * start just before it goes, through a pidfd on Linux; macOS keeps a check-to-kill race of
 * microseconds, `process-signal.ts`). A member is one of:
 *
 * - recorded while the leader pinned the group;
 * - a child of a recorded member, proven by a parent link read with the child's start;
 * - in the group when the leader's exit is heard, AND linked to the spawn by evidence fixed while
 *   the leader lived: on macOS its starting parent's unique id (never reused, kept across
 *   orphaning) is the leader's or a recorded member's; on Linux its start environment carries
 *   this spawn's random token (`group-token.ts`), read as identity, environment, identity.
 *
 * What escapes: on Linux, a process that started with a cleaned environment and was never
 * recorded; on macOS, one whose starting parent exited unrecorded. The daemon's sweeps (owned
 * trees, run markers, lineage) remain the backstop for those.
 *
 * Linux and macOS only; Windows trees stop through taskkill and Job Objects.
 */
export interface LeaderGroup {
  readonly leader: number;
  /** Call first in the leader's own exit listener: the group number is never signalled again. */
  reaped(): void;
  signal(signal: NodeJS.Signals): void;
  /** Whether anything of the group is left: the group itself while pinned, else its members. */
  running(): boolean;
  /** SIGTERM, then SIGKILL after `graceMs` if anything is left. */
  stop(graceMs: number): Promise<void>;
}

export type GroupIo = { tree: TreeIo; listing: ProcessListing };
const systemGroupIo: GroupIo = { tree: systemTreeIo, listing: systemListing };

/** The start a pid shows now, a zombie's included: what a leader's pin is checked against. */
function startOf(pid: number, listing: ProcessListing): string | undefined {
  try {
    return listing.info(pid)?.start;
  } catch {
    return undefined;
  }
}

type Evidence = { start?: string | undefined; unique?: string | undefined; token?: string };

function createGroup(leader: number, evidence: Evidence, io: GroupIo): LeaderGroup {
  const known = new Map<number, string>();
  const uniques = new Set<string>();
  if (evidence.unique) uniques.add(evidence.unique);
  let reaped = false;
  const pinned = () =>
    !reaped && (evidence.start === undefined || startOf(leader, io.listing) === evidence.start);
  const remember = (members: readonly TreeMember[]) => {
    for (const member of members) {
      known.set(member.pid, member.start);
      const unique = readUnique(member);
      if (unique) uniques.add(unique);
    }
  };
  const readUnique = (member: TreeMember) => {
    try {
      const ids = io.listing.ancestry?.(member.pid);
      return ids && io.tree.identity(member.pid)?.start === member.start ? ids.unique : undefined;
    } catch {
      return undefined;
    }
  };
  const members = () => [...known].map(([pid, start]) => ({ pid, start }));
  const inGroup = () => {
    const found: TreeMember[] = [];
    for (const pid of io.listing.groupMembers(leader)) {
      const identity = io.tree.identity(pid);
      if (identity?.group === leader) found.push({ pid, start: identity.start });
    }
    return found;
  };
  /** While pinned: the group's members and the leader's tree. Kept only if still pinned after. */
  const capture = () => {
    try {
      const found = [...inGroup(), ...captureTree([leader], io.tree).members];
      if (pinned()) remember(found);
    } catch (error) {
      process.emitWarning(`Could not read process group ${leader}: ${String(error)}`);
    }
  };
  /** Whether a process found in the group after the reap is linked to this spawn. */
  const linked = (member: TreeMember): boolean => {
    try {
      const ancestry = io.listing.ancestry;
      if (ancestry) {
        const ids = ancestry(member.pid);
        if (!ids || !uniques.has(ids.parentUnique)) return false;
        if (io.tree.identity(member.pid)?.start !== member.start) return false;
        uniques.add(ids.unique);
        return true;
      }
      if (evidence.token === undefined) return false;
      const environment = io.listing.environment(member.pid);
      if (!environment || !carriesGroupToken(environment, evidence.token)) return false;
      return io.tree.identity(member.pid)?.start === member.start;
    } catch {
      return false;
    }
  };
  /** At the reap: group members linked to the spawn, parents before children (macOS). */
  const adopt = () => {
    try {
      let pending = inGroup().filter((member) => known.get(member.pid) !== member.start);
      for (let grew = true; grew && pending.length;) {
        grew = false;
        const left: TreeMember[] = [];
        for (const member of pending)
          if (linked(member)) {
            known.set(member.pid, member.start);
            grew = true;
          } else left.push(member);
        pending = left;
      }
    } catch (error) {
      process.emitWarning(`Could not read process group ${leader}: ${String(error)}`);
    }
  };
  /** Known members still running, with the children they were proven to start since. */
  const live = () => {
    try {
      const before = liveMembers(members(), io.tree);
      remember(
        captureTree(
          before.map((member) => member.pid),
          io.tree,
        ).members,
      );
      return liveMembers(members(), io.tree);
    } catch (error) {
      process.emitWarning(`Could not read process group ${leader}'s members: ${String(error)}`);
      return [];
    }
  };
  const local = (request: RelayedSignal) => deliver(request, io);
  const group: LeaderGroup = {
    leader,
    reaped() {
      if (reaped) return;
      reaped = true;
      adopt();
    },
    signal(signal) {
      const isPinned = pinned();
      if (isPinned) capture();
      const request: RelayedSignal = {
        ...(isPinned && pinned() ? { leader: { pid: leader, start: evidence.start ?? "" } } : {}),
        members: live(),
        signal,
      };
      // Our own unreaped child with no start read: its pin is the exit not yet heard.
      if (request.leader && evidence.start === undefined) {
        killGroup(leader, signal);
        return;
      }
      if (relaysSignals(locallyGuarded())) relaySignal(request, () => local(request));
      else local(request);
    },
    running() {
      if (pinned()) return groupRunning(leader);
      return live().length > 0;
    },
    async stop(graceMs) {
      group.signal("SIGTERM");
      const deadline = performance.now() + graceMs;
      while (group.running()) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          group.signal("SIGKILL");
          return;
        }
        await delay(Math.min(25, remaining));
      }
    },
  };
  return group;
}

/** A signal with its evidence, in the isolate whose rules apply. */
function deliver(request: RelayedSignal, io: GroupIo): void {
  if (request.leader && startOf(request.leader.pid, io.listing) === request.leader.start)
    killGroup(request.leader.pid, request.signal);
  else signalOwnedMembers(request.members, request.signal, io.tree);
}

function groupRunning(leader: number): boolean {
  try {
    process.kill(-leader, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || (process.platform === "darwin" && code === "EPERM")) return false;
    throw error;
  }
}

/**
 * The group of a child this isolate just spawned, read before its exit can be heard. Call
 * `reaped()` first in its exit listener. `token` is the group token put in its environment.
 */
export function childGroup(pid: number, token?: string, io: GroupIo = systemGroupIo): LeaderGroup {
  let start: string | undefined;
  let unique: string | undefined;
  try {
    start = io.listing.info(pid)?.start;
    unique = io.listing.ancestry?.(pid)?.unique;
  } catch {
    // Unreadable: the pin is the exit not yet heard.
  }
  return createGroup(pid, { start, unique, ...(token === undefined ? {} : { token }) }, io);
}

/**
 * A group whose leader someone else spawned and reported (another isolate or process), known by
 * the identity read where it started. Pinned only while that leader still shows that start.
 */
export function reportedGroup(
  leader: TreeMember & { unique?: string | undefined },
  io: GroupIo = systemGroupIo,
): LeaderGroup {
  return createGroup(leader.pid, { start: leader.start, unique: leader.unique }, io);
}

/** Stop a retained group and end its ownership. */
export async function stopRetainedGroup(group: LeaderGroup, graceMs: number): Promise<void> {
  await group.stop(graceMs);
  unregisterGroup(group.leader);
}

/**
 * Install the rules every group and member signal passes through, in this isolate and for
 * workers that relay theirs here. Returns their removal.
 */
export function guardGroupSignals(guard: GroupGuard, members?: MemberGuard): () => void {
  const removeGuards = installGroupGuards(guard, members);
  const stopServing = serveRelayedSignals((request) => deliver(request, systemGroupIo));
  return () => {
    stopServing();
    removeGuards();
  };
}
