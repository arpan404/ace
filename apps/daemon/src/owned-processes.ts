import { realpathSync } from "node:fs";
import { join } from "node:path";
import { logError, logFields, type ComponentLogger } from "@ace/diagnostics";
import { EscapeeJournal } from "@ace/provider-kit/escapee-journal";
import { ownedGroupLeaders, onGroupOwned } from "@ace/provider-kit/process";
import {
  cgroupMembers,
  cgroupOf,
  lineage,
  systemListing,
  systemProcFs,
  type ProcFs,
  type ProcessListing,
} from "@ace/provider-kit/process-listing";
import { claimProcessOwner, markedProcesses, observeKept } from "@ace/provider-kit/process-marker";
import { becomeSubreaper, reap, zombieChildren } from "@ace/provider-kit/process-reaper";
import {
  captureTree,
  liveMembers,
  memberOf,
  stopMembers,
  systemTreeIo,
  type TreeIo,
  type TreeMember,
} from "@ace/provider-kit/process-tree";
import { ProcessWatch } from "@ace/provider-kit/process-watch";
import { isDaemonUnit } from "@ace/service";
import { signallable } from "./owned-evidence.ts";

/*
 * Everything a daemon run starts through provider-kit is the run's to stop, wherever it went.
 * Layers, because no one way finds every process on every platform:
 *
 * 1. Its owned process groups and their trees, read by parent pid at shutdown.
 * 2. The watch's snapshots (`ProcessWatch`): a process seen while its parent lived, so an
 *    orphan the kernel since gave to init is still known.
 * 3. The marker: `ACE_PROCESS_OWNER=<run id>` in every marked spawn's environment, inherited by
 *    its children. Linux shows every same-user process's start environment; macOS hides that of
 *    Apple's platform binaries (sh, zsh, bash, sleep and the rest of the OS).
 * 4. Linux: the daemon is a child subreaper, so orphans stay in its tree; and under this home's
 *    own systemd unit, the unit's cgroup holds every process the service started.
 *
 * Each layer only nominates candidates; `owned-evidence.ts` then spares the daemon's lineage, a
 * stop request's caller chain, kept processes and other ace daemons with all below them.
 *
 * What none reaches: on macOS, a process that runs a platform binary or starts with a clean
 * environment AND leaves its tree before any snapshot (inside the 3 s between two). On Linux
 * outside systemd, one that starts with a clean environment and its own session and outlives
 * its parent before any snapshot is still in the daemon's tree, but can't be told from a
 * process the daemon itself started, so it is left alone.
 */

/** What a shutdown must stop, and whether the reading saw everything. */
export type OwnedCapture = { members: TreeMember[]; complete: boolean };

export interface OwnedProcesses {
  /**
   * Every process the run must stop, read before shutdown signals any of them. `spare` is a
   * stop request's caller chain: never signalled, so the caller lives to read its receipt.
   */
  capture(spare?: readonly TreeMember[]): OwnedCapture;
  /** Stop what an earlier run of this home left running: its marker and its journal. */
  sweepEarlier(owner: string | undefined): Promise<{ found: number; left: TreeMember[] }>;
  close(): void;
}

/** The home a process's start environment names, resolved; undefined when it names none. */
function homeOf(listing: ProcessListing, pid: number): string | undefined {
  const value = listing
    .environment(pid)
    ?.find((entry) => entry.startsWith("ACE_HOME="))
    ?.slice("ACE_HOME=".length);
  if (!value) return undefined;
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

/**
 * Linux: the daemon unit's cgroup members, only when the daemon runs in THIS home's unit: the
 * cgroup's name is a daemon unit's, and the supervisor that runs the daemon (its parent, in the
 * same cgroup) was started for this home (`ACE_HOME`). Any other cgroup gives nothing.
 */
export function serviceCgroupMembers(options: {
  listing: ProcessListing;
  proc: ProcFs;
  self: number;
  /** This home, resolved. */
  home: string;
}): number[] {
  const { listing, proc, self, home } = options;
  if (listing.platform !== "linux") return [];
  const group = cgroupOf(self, proc);
  if (!group || !isDaemonUnit(group.unit)) return [];
  const supervisor = listing.info(self)?.parent;
  if (supervisor === undefined || cgroupOf(supervisor, proc)?.path !== group.path) return [];
  if (homeOf(listing, supervisor) !== home) return [];
  return cgroupMembers(group.path, proc);
}

export function ownProcesses(options: {
  home: string;
  run: string;
  log: ComponentLogger;
  tree?: TreeIo;
  listing?: ProcessListing;
}): OwnedProcesses {
  const tree = options.tree ?? systemTreeIo;
  const listing = options.listing ?? systemListing;
  const { log, run } = options;
  const home = (() => {
    try {
      return realpathSync(options.home);
    } catch {
      return options.home;
    }
  })();
  const release = claimProcessOwner(run);
  const subreaper = becomeSubreaper(listing.platform);
  if (listing.platform === "linux" && !subreaper)
    log.log("warn", "The daemon could not become a child subreaper; orphans go to init");
  let journal: EscapeeJournal | undefined;
  try {
    journal = new EscapeeJournal(join(options.home, "processes.sqlite"), run, (pid) =>
      memberOf(pid, tree),
    );
  } catch (error) {
    log.log("warn", "The escaped-process journal could not open", logError(error));
  }
  const unkept = journal ? observeKept(journal) : () => {};
  const self = memberOf(process.pid, tree);
  const selfGroup = tree.identity(process.pid)?.group;
  const watch = new ProcessWatch({
    tree,
    leaders: ownedGroupLeaders,
    schedule(task, milliseconds) {
      const timer = setTimeout(task, milliseconds);
      timer.unref();
      return () => clearTimeout(timer);
    },
    ...(journal ? { journal } : {}),
    ...(subreaper && selfGroup !== undefined
      ? {
          reaper: {
            self: { pid: process.pid, group: selfGroup },
            zombies: () => zombieChildren(listing.lister()(process.pid), listing),
            reap,
          },
        }
      : {}),
    report: (error) => log.log("warn", "The process watch failed a snapshot", logError(error)),
  });
  const unsubscribe = onGroupOwned(() => watch.wake());
  if (ownedGroupLeaders().length) watch.wake();

  /** The rules, for one sweep: this daemon, its lineage, `extra` spared, kept processes kept. */
  const rules = (extra: readonly TreeMember[]) => {
    const spare = lineage(process.pid, listing);
    for (const member of liveMembers(extra, tree)) spare.add(member.pid);
    return signallable(listing, { self, spare, kept: journal?.kept() ?? [] });
  };
  const serviceCgroup = () =>
    serviceCgroupMembers({ listing, proc: systemProcFs, self: process.pid, home });

  let closed = false;
  return {
    capture(spare = []) {
      const allowed = rules(spare);
      const found = new Map<number, TreeMember>();
      const add = (members: readonly TreeMember[]) => {
        for (const member of members)
          if (!found.has(member.pid) && allowed(member)) found.set(member.pid, member);
      };
      const owned = captureTree(ownedGroupLeaders(), tree);
      add(owned.members);
      add(watch.members());
      const resolve = (pids: readonly number[]) =>
        add(pids.flatMap((pid) => memberOf(pid, tree) ?? []));
      resolve(markedProcesses(run, listing));
      resolve(serviceCgroup());
      return { members: [...found.values()], complete: !owned.truncated };
    },
    async sweepEarlier(owner) {
      const allowed = rules([]);
      const found = new Map<number, TreeMember>();
      const consider = (member: TreeMember) => {
        if (!found.has(member.pid) && allowed(member)) found.set(member.pid, member);
      };
      if (owner && owner !== run)
        for (const pid of markedProcesses(owner, listing)) {
          const member = memberOf(pid, tree);
          if (member) consider(member);
        }
      const rows = journal?.earlier() ?? [];
      for (const member of liveMembers(rows, tree)) consider(member);
      const left = found.size ? await stopMembers([...found.values()], 500, tree) : [];
      // Rows whose process is gone (stopped now or long ago) are spent; survivors stay as evidence.
      const kept = new Set(left.map((member) => `${member.pid}:${member.start}`));
      journal?.forget(rows.filter((row) => !kept.has(`${row.pid}:${row.start}`)));
      if (found.size)
        log.log(
          left.length ? "warn" : "info",
          "Stopped processes an earlier daemon run left running",
          logFields([
            ["found", found.size],
            ["left", left.length],
          ]),
        );
      return { found: found.size, left };
    },
    close() {
      if (closed) return;
      closed = true;
      watch.close();
      unsubscribe();
      unkept();
      journal?.close();
      release();
    },
  };
}
