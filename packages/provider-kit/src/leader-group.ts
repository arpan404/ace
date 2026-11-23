import { setTimeout as delay } from "node:timers/promises";
import { systemListing } from "./process-listing.ts";
import { carriesGroupToken } from "./group-token.ts";
import { deliverGroupSignal, startOf, type GroupIo, type GroupSignal } from "./group-delivery.ts";
import {
  installGroupGuards,
  unregisterGroup,
  type GroupGuard,
  type MemberGuard,
} from "./process-owner.ts";
import { captureFrom, liveMembers, systemTreeIo, type TreeMember } from "./process-tree.ts";
import { relaySignal, relaysSignals, serveWorkerSignals } from "./signal-relay.ts";
import { noStartOrder, systemStartOrder } from "./start-order.ts";
export type { GroupIo } from "./group-delivery.ts";

/*
 * A process group ace started, signalled so that a signal never reaches a group ace doesn't own.
 *
 * While the leader is unreaped (running, or a zombie no one has waited for) its pid holds the
 * group id, so the group may be signalled by number. `pinned`: the leader's own exit not yet
 * heard, AND its pid still showing the start recorded at spawn, checked again after the rules'
 * scan, immediately before kill(-pid) (`group-delivery.ts`). A leader whose start could not be
 * recorded is never signalled by number. Every signal sent while pinned first records the
 * group's members and the leader's tree, with start times (and macOS unique ids), kept only if
 * the pin held through the read.
 *
 * Once the leader is reaped its group id is free as soon as the group empties, and may then name
 * an unrelated group. From then on the number is never signalled. Signals go to members one by
 * one (`signalTreeMember`: each checked against its start just before it goes, through a pidfd on
 * Linux). A member is one of:
 *
 * - recorded while the leader pinned the group;
 * - a child of a recorded member, from a walk whose roots must still show their recorded starts
 *   and whose every parent link is read with the child's start;
 * - in the group when the leader's exit is heard, AND either started before that moment (its
 *   kernel start, `start-order.ts`: it joined while the id was still the leader's; a group that
 *   took the id during the scan holds only later starts) or linked to the spawn by evidence
 *   fixed while the leader lived: on macOS its starting parent's unique id (never reused, kept
 *   across orphaning) is the leader's or a recorded member's; on Linux its start environment
 *   carries this spawn's random token (`group-token.ts`), read as identity, environment,
 *   identity.
 *
 * Residual risk. Node and Bun reap a child before any JS hears it exited, so this only narrows
 * the window in which a reused group id can be hit; the full fix is a supervisor that keeps the
 * leader unreaped until its group is empty (the Rust supervisor, E2a). What remains here:
 * - the check-to-kill gap: between the last pin check and kill(-pid), or a member's start check
 *   and kill(2) on macOS, the process must exit, be reaped and its id be reused: the pid range
 *   cycling within microseconds;
 * - the reap-to-heard gap: a group that took the id after the reap but before the exit listener
 *   ran (a blocked event loop widens it) starts before the cutoff and would be adopted; it takes
 *   the pid range cycling within that gap;
 * - late forks: a process started after its parent's last scan, whose parent then exits before
 *   the next one, is not seen (it is reparented and left its group's lineage on Linux);
 * - Linux children that start with a cleaned environment carry no token and are not adopted;
 * - the token is a correlation marker, not proof: it is visible to any tool that can read the
 *   environment, so a process of the same user could copy it into an unrelated group.
 * The daemon's sweeps (owned trees, run markers, lineage) remain the backstop for what escapes.
 *
 * Linux and macOS only; Windows trees stop through taskkill and Job Objects.
 */
export interface LeaderGroup {
  readonly leader: number;
  /** Call first in the leader's own exit listener: the group number is never signalled again. */
  reaped(): void;
  /** Resolves once delivered (in a worker: by the main isolate, under its rules). */
  signal(signal: NodeJS.Signals): Promise<void>;
  /** Whether anything of the group is left: the group until the reap is heard, then its members. */
  running(): boolean;
  /** SIGTERM; after `graceMs` from its delivery, SIGKILL if anything is left, awaited. */
  stop(graceMs: number): Promise<void>;
}

const systemGroupIo: GroupIo = {
  tree: systemTreeIo,
  listing: systemListing,
  order: systemStartOrder(),
};

type Evidence = { start: string | undefined; unique?: string | undefined; token?: string };

function createGroup(leader: number, evidence: Evidence, io: GroupIo): LeaderGroup {
  const known = new Map<number, string>();
  const uniques = new Set<string>();
  if (evidence.unique) uniques.add(evidence.unique);
  let reaped = false;
  const recorded = evidence.start;
  const pinned = () =>
    !reaped && recorded !== undefined && startOf(leader, io.listing) === recorded;
  const readUnique = (member: TreeMember) => {
    try {
      const ids = io.listing.ancestry?.(member.pid);
      return ids && io.tree.identity(member.pid)?.start === member.start ? ids.unique : undefined;
    } catch {
      return undefined;
    }
  };
  const remember = (members: readonly TreeMember[]) => {
    for (const member of members) {
      known.set(member.pid, member.start);
      const unique = readUnique(member);
      if (unique) uniques.add(unique);
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
    if (recorded === undefined) return;
    try {
      const found = [
        ...inGroup(),
        ...captureFrom([{ pid: leader, start: recorded }], io.tree).members,
      ];
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
  /**
   * At the reap: group members that started before the exit was heard (`heard`, in kernel start
   * units: they joined the group while its id was still the leader's, and a group that took the
   * id during this scan holds only later starts), or are linked to the spawn, parents before
   * children (macOS).
   */
  const adopt = () => {
    try {
      const order = io.order ?? noStartOrder;
      const heard = order.now();
      const earlier = (member: TreeMember) => {
        const position = order.position(member.start);
        return heard !== undefined && position !== undefined && position < heard;
      };
      let pending: TreeMember[] = [];
      for (const member of inGroup()) {
        if (known.get(member.pid) === member.start) continue;
        if (earlier(member)) remember([member]);
        else pending.push(member);
      }
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
      remember(captureFrom(liveMembers(members(), io.tree), io.tree).members);
      return liveMembers(members(), io.tree);
    } catch (error) {
      process.emitWarning(`Could not read process group ${leader}'s members: ${String(error)}`);
      return [];
    }
  };
  const group: LeaderGroup = {
    leader,
    reaped() {
      if (reaped) return;
      reaped = true;
      adopt();
    },
    async signal(signal) {
      if (pinned()) capture();
      const request: GroupSignal = {
        leader: { pid: leader, start: recorded ?? "" },
        unreaped: recorded !== undefined && !reaped,
        members: live(),
        signal,
      };
      const local = () => deliverGroupSignal(request, io);
      if (relaysSignals()) await relaySignal(request, local);
      else local();
    },
    running() {
      // A liveness probe sends nothing, so it may ask by number until the reap is heard: a
      // leader that has exited unheard (a zombie macOS can't read) still pins its group. After
      // the reap, only members proven ours count.
      if (!reaped && groupRunning(leader)) return true;
      return live().length > 0;
    },
    async stop(graceMs) {
      await group.signal("SIGTERM");
      const deadline = performance.now() + graceMs;
      while (group.running()) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          await group.signal("SIGKILL");
          return;
        }
        await delay(Math.min(25, remaining));
      }
    },
  };
  return group;
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
    // Unreadable: never signalled by number, and nothing is recorded for it.
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
 * workers, which relay theirs here. Returns their removal.
 */
export function guardGroupSignals(guard: GroupGuard, members?: MemberGuard): () => void {
  serveWorkerSignals();
  return installGroupGuards(guard, members);
}

/** Signal from code that can't wait (exit listeners, timers): a refusal is reported, not thrown. */
export function signalSoon(group: LeaderGroup, signal: NodeJS.Signals): void {
  group
    .signal(signal)
    .catch((error: unknown) =>
      process.emitWarning(`Could not signal process group ${group.leader}: ${String(error)}`),
    );
}
