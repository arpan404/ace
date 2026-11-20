import { join } from "node:path";
import { logError, logFields, type ComponentLogger } from "@ace/diagnostics";
import { EscapeeJournal } from "@ace/provider-kit/escapee-journal";
import { ownedGroupLeaders, onGroupOwned } from "@ace/provider-kit/process";
import {
  cgroupMembers,
  cgroupOf,
  lineage,
  systemListing,
  type ProcessListing,
} from "@ace/provider-kit/process-listing";
import { claimProcessOwner, markedProcesses } from "@ace/provider-kit/process-marker";
import { becomeSubreaper, reap, zombieChildren } from "@ace/provider-kit/process-reaper";
import {
  captureDescendants,
  liveMembers,
  memberOf,
  stopMembers,
  systemTreeIo,
  type TreeIo,
  type TreeMember,
} from "@ace/provider-kit/process-tree";
import { ProcessWatch } from "@ace/provider-kit/process-watch";
import { isDaemonUnit } from "@ace/service";

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
 * 4. Linux: the daemon is a child subreaper, so orphans stay in its tree; and under its systemd
 *    unit, the unit's cgroup holds every process the service started.
 *
 * What none reaches: on macOS, a process that runs a platform binary or starts with a clean
 * environment AND leaves its tree before any snapshot (inside the 3 s between two). On Linux
 * outside systemd, one that starts with a clean environment and its own session and outlives
 * its parent before any snapshot is still in the daemon's tree, but can't be told from a
 * process the daemon itself started, so it is left alone.
 */

export interface OwnedProcesses {
  /** Every process the run must stop, read before shutdown signals any of them. */
  capture(): TreeMember[];
  /** Stop what an earlier run of this home left running: its marker and its journal. */
  sweepEarlier(owner: string | undefined): Promise<{ found: number; left: TreeMember[] }>;
  close(): void;
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
  const release = claimProcessOwner(run);
  const subreaper = becomeSubreaper(listing.platform);
  if (listing.platform === "linux" && !subreaper)
    log.log("warn", "The daemon could not become a child subreaper; orphans go to init");
  let journal: EscapeeJournal | undefined;
  try {
    journal = new EscapeeJournal(join(options.home, "processes.sqlite"), run);
  } catch (error) {
    log.log("warn", "The escaped-process journal could not open", logError(error));
  }
  const self = tree.identity(process.pid);
  const watch = new ProcessWatch({
    tree,
    leaders: ownedGroupLeaders,
    schedule(task, milliseconds) {
      const timer = setTimeout(task, milliseconds);
      timer.unref();
      return () => clearTimeout(timer);
    },
    ...(journal ? { journal } : {}),
    ...(subreaper && self
      ? {
          reaper: {
            self: { pid: process.pid, group: self.group },
            zombies: () => zombieChildren(listing.children(process.pid)),
            reap,
          },
        }
      : {}),
    report: (error) => log.log("warn", "The process watch failed a snapshot", logError(error)),
  });
  const unsubscribe = onGroupOwned(() => watch.wake());
  if (ownedGroupLeaders().length) watch.wake();

  /** Members of `pids` that are running now, never this process or one of its ancestors. */
  const resolve = (pids: Iterable<number>, keep: Map<number, TreeMember>, spare: Set<number>) => {
    for (const pid of pids) {
      if (spare.has(pid) || keep.has(pid)) continue;
      const member = memberOf(pid, tree);
      if (member) keep.set(pid, member);
    }
  };
  const serviceCgroup = (): number[] => {
    if (listing.platform !== "linux") return [];
    const group = cgroupOf();
    return group && isDaemonUnit(group.unit) ? cgroupMembers(group.path) : [];
  };

  return {
    capture() {
      const spare = lineage(process.pid, listing);
      const found = new Map<number, TreeMember>();
      const add = (members: readonly TreeMember[]) => {
        for (const member of members)
          if (!spare.has(member.pid) && !found.has(member.pid)) found.set(member.pid, member);
      };
      add(captureDescendants(ownedGroupLeaders(), tree));
      add(watch.members());
      resolve(markedProcesses(run, listing), found, spare);
      resolve(serviceCgroup(), found, spare);
      return [...found.values()];
    },
    async sweepEarlier(owner) {
      const spare = lineage(process.pid, listing);
      const found = new Map<number, TreeMember>();
      if (owner && owner !== run) resolve(markedProcesses(owner, listing), found, spare);
      const rows = journal?.earlier() ?? [];
      for (const member of liveMembers(rows, tree))
        if (!spare.has(member.pid) && !found.has(member.pid)) found.set(member.pid, member);
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
      watch.close();
      unsubscribe();
      journal?.close();
      release();
    },
  };
}
