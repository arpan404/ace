import { realpathSync } from "node:fs";
import { join } from "node:path";
import { logError, logFields, type ComponentLogger } from "@ace/diagnostics";
import { EscapeeJournal, readOwnership } from "@ace/provider-kit/escapee-journal";
import { guardGroupSignals, ownedGroupLeaders, onGroupOwned } from "@ace/provider-kit/process";
import { LineageBook, lineageDescendants } from "@ace/provider-kit/process-lineage";
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
import { verifiedCaller, type Connection, type PeerIo } from "./peer-process.ts";

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
 * 4. macOS: lineage by kernel unique id (`process-lineage.ts`): an orphan whose starting
 *    parent was one of this run's recorded processes, even if it was never seen itself.
 * 5. Linux: the daemon is a child subreaper, so orphans stay in its tree; and under this home's
 *    own systemd unit, the unit's cgroup holds every process the service started.
 *
 * Group signals pass a guard too: a group holding a protected process (another home's daemon,
 * a kept process, the caller) is signalled member by member, never as a whole.
 *
 * Each layer only nominates candidates; `owned-evidence.ts` then spares the daemon's lineage, a
 * stop request's caller chain, kept processes and other ace daemons with all below them.
 *
 * What none reaches: on macOS, a process whose starting parent was never recorded (it was not a
 * leader, and it started and exited between two snapshots, 3 s apart), when the process itself
 * also runs a platform binary or starts with a clean environment. On Linux
 * outside systemd, one that starts with a clean environment and its own session and outlives
 * its parent before any snapshot is still in the daemon's tree, but can't be told from a
 * process the daemon itself started, so it is left alone.
 */

/** What a shutdown must stop, and whether the reading saw everything. */
export type OwnedCapture = { members: TreeMember[]; complete: boolean };

export interface OwnedProcesses {
  /** A stop request's caller chain, verified against the request's connection. */
  verifyCaller(
    hint: readonly TreeMember[] | undefined,
    connection: Connection,
  ): Promise<TreeMember[]>;
  /** Spare a verified caller chain from every sweep and group signal, so it reads its receipt. */
  spareCaller(members: readonly TreeMember[]): void;
  /** Every process the run must stop, read before shutdown signals any of them. */
  capture(): OwnedCapture;
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
  peer?: PeerIo;
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
  /** Kept rows, also readable once the journal has closed (the exit-time group cleanup). */
  let keptCache: TreeMember[] = journal?.kept() ?? [];
  const kept = () => (journal && !closed ? (keptCache = journal.kept()) : keptCache);
  const book = new LineageBook(journal ? { journal } : {});
  const self = memberOf(process.pid, tree);
  const watch = new ProcessWatch({
    tree,
    leaders: ownedGroupLeaders,
    schedule(task, milliseconds) {
      const timer = setTimeout(task, milliseconds);
      timer.unref();
      return () => clearTimeout(timer);
    },
    ...(journal ? { journal } : {}),
    ...(subreaper
      ? {
          reaper: {
            self: { pid: process.pid, group: tree.identity(process.pid)?.group ?? process.pid },
            zombies: () => zombieChildren(listing.lister()(process.pid), listing),
            reap,
          },
        }
      : {}),
    learned: (pids) => {
      for (const pid of pids) book.noteProcess(pid, listing);
    },
    report: (error) => log.log("warn", "The process watch failed a snapshot", logError(error)),
  });
  const unsubscribe = onGroupOwned((pid, unique) => {
    if (unique) book.note(unique);
    else book.noteProcess(pid, listing);
    watch.wake();
  });
  for (const pid of ownedGroupLeaders()) book.noteProcess(pid, listing);
  if (ownedGroupLeaders().length) watch.wake();

  /** A stop request's verified caller chain: spared by every sweep and group signal. */
  let caller: TreeMember[] = [];
  /** The rules: this daemon and its lineage, the caller chain, kept processes, other daemons. */
  const rules = () => {
    const spare = lineage(process.pid, listing);
    for (const member of liveMembers(caller, tree)) spare.add(member.pid);
    return signallable(listing, { self, spare, kept: kept() });
  };
  // Every group signal: a protected member makes the group signalled member by member instead.
  guardGroupSignals((group) => {
    const members = listing.groupMembers(group).flatMap((pid) => memberOf(pid, tree) ?? []);
    const allowed = members.filter(rules());
    return allowed.length === members.length ? "whole" : allowed;
  });
  const serviceCgroup = () =>
    serviceCgroupMembers({ listing, proc: systemProcFs, self: process.pid, home });

  let closed = false;
  return {
    verifyCaller: (hint, connection) => verifiedCaller(hint, connection, listing, options.peer),
    spareCaller(members) {
      // The caller and its shell: the chain from the caller up to, not including, the first
      // provider (an owned group's leader) or this daemon. A provider is never spared for having
      // run the command that stops it.
      const stops = new Set([process.pid, ...ownedGroupLeaders()]);
      const end = members.findIndex((member) => stops.has(member.pid));
      caller = end < 0 ? [...members] : members.slice(0, end);
    },
    capture() {
      const allowed = rules();
      const found = new Map<number, TreeMember>();
      const add = (members: readonly TreeMember[]) => {
        for (const member of members)
          if (!found.has(member.pid) && allowed(member)) found.set(member.pid, member);
      };
      const owned = captureTree(ownedGroupLeaders(), tree);
      add(owned.members.map(({ pid, start }) => ({ pid, start })));
      add(watch.members());
      add(markedProcesses(run, listing));
      const traced = lineageDescendants(book.roots(), listing);
      if (traced) add(traced);
      add(serviceCgroup().flatMap((pid) => memberOf(pid, tree) ?? []));
      return {
        members: [...found.values()],
        complete: !owned.truncated && watch.complete() && book.complete(),
      };
    },
    async sweepEarlier(owner) {
      const allowed = rules();
      const found = new Map<number, TreeMember>();
      const consider = (member: TreeMember) => {
        if (!found.has(member.pid) && allowed(member)) found.set(member.pid, member);
      };
      if (owner && owner !== run)
        for (const member of markedProcesses(owner, listing)) consider(member);
      const rows = journal?.earlier() ?? [];
      for (const member of liveMembers(rows, tree)) consider(member);
      // What an earlier run's processes started, traced by lineage (macOS).
      const earlierLineage = owner
        ? readOwnership(join(options.home, "processes.sqlite"), owner).lineage
        : [];
      for (const member of lineageDescendants(earlierLineage, listing) ?? []) consider(member);
      const left = found.size ? await stopMembers([...found.values()], 500, tree) : [];
      // Rows whose process is gone (stopped now or long ago) are spent; survivors stay as evidence.
      const survivors = new Set(left.map((member) => `${member.pid}:${member.start}`));
      journal?.forget(rows.filter((row) => !survivors.has(`${row.pid}:${row.start}`)));
      if (!left.length) journal?.forgetEarlierLineage();
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
      keptCache = journal?.kept() ?? keptCache;
      closed = true;
      watch.close();
      unsubscribe();
      unkept();
      journal?.close();
      release();
    },
  };
}
