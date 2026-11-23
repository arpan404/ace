import { setTimeout as delay } from "node:timers/promises";
import { systemListing, type ProcessListing } from "./process-listing.ts";
import { killGroup, signalOwnedMembers } from "./process-owner.ts";
import {
  captureTree,
  liveMembers,
  systemTreeIo,
  type TreeIo,
  type TreeMember,
} from "./process-tree.ts";

/*
 * A spawned leader's process group, signalled so that a signal never reaches a group ace does
 * not own.
 *
 * While the leader is unreaped (running, or a zombie Node has not waited for yet) its pid holds
 * the group id, so the group can be signalled by number. Once Node has reaped it, the id is
 * freed as soon as the last member leaves, and the kernel can hand it to an unrelated group.
 * From then on the group number is never signalled: each member captured earlier is signalled
 * on its own, checked against its start time just before the signal (a pidfd pins it on Linux),
 * and their children are added when a parent link read with the child's start proves them.
 *
 * Members are captured at every signal sent while the leader is unreaped, and once more as the
 * first thing the leader's exit listener does. Node and Bun reap a child before any JS hears of
 * its exit, so that last capture runs just after the reap, in the same event-loop turn. For it to
 * see someone else's group, the group would have to empty and its id be reused by a new group
 * within that turn, which takes the whole pid range cycling (Linux and macOS hand out pids in
 * order): the same residual race as macOS's check-to-kill (`process-signal.ts`). Without it a
 * leader that exits on its own, never stopped, could not take its descendants along.
 *
 * Linux and macOS only; Windows trees stop through taskkill and Job Objects.
 */
export interface LeaderGroup {
  readonly leader: number;
  /** Call first in the leader's exit listener: the group number is never signalled again. */
  reaped(): void;
  signal(signal: NodeJS.Signals): void;
  /** Whether anything captured is still running (the group itself, while the leader is unreaped). */
  running(): boolean;
  /** SIGTERM, then SIGKILL after `graceMs` if anything is left; resolves once nothing is. */
  stop(graceMs: number): Promise<void>;
}

export function leaderGroup(
  leader: number,
  io: TreeIo = systemTreeIo,
  listing: ProcessListing = systemListing,
): LeaderGroup {
  const known = new Map<number, string>();
  let reaped = false;
  const remember = (members: readonly TreeMember[]) => {
    for (const member of members) known.set(member.pid, member.start);
  };
  const members = () => [...known].map(([pid, start]) => ({ pid, start }));
  /** The group's members and the leader's tree, read while the leader still pins the group. */
  const capture = () => {
    try {
      const inGroup: TreeMember[] = [];
      for (const pid of listing.groupMembers(leader)) {
        const identity = io.identity(pid);
        if (identity?.group === leader) inGroup.push({ pid, start: identity.start });
      }
      remember(inGroup);
      remember(captureTree([leader], io).members);
    } catch (error) {
      process.emitWarning(`Could not read process group ${leader}: ${String(error)}`);
    }
  };
  /** Captured members still running, with the children they were proven to start since. */
  const live = () => {
    let alive: TreeMember[] = [];
    try {
      alive = liveMembers(members(), io);
      remember(
        captureTree(
          alive.map((member) => member.pid),
          io,
        ).members,
      );
      alive = liveMembers(members(), io);
    } catch (error) {
      process.emitWarning(`Could not read process group ${leader}'s members: ${String(error)}`);
    }
    return alive;
  };
  const groupRunning = () => {
    try {
      process.kill(-leader, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH" || (process.platform === "darwin" && code === "EPERM")) return false;
      throw error;
    }
  };
  const group: LeaderGroup = {
    leader,
    reaped() {
      if (reaped) return;
      capture();
      reaped = true;
    },
    signal(signal) {
      if (!reaped) {
        capture();
        killGroup(leader, signal);
        return;
      }
      signalOwnedMembers(live(), signal);
    },
    running: () => (reaped ? live().length > 0 : groupRunning()),
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
