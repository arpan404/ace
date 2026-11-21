import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readOwnership } from "@ace/provider-kit/escapee-journal";
import { readOwnedGroups } from "@ace/provider-kit/process-inventory";
import { lineage, systemListing, type ProcessListing } from "@ace/provider-kit/process-listing";
import { lineageDescendants } from "@ace/provider-kit/process-lineage";
import { markedProcesses } from "@ace/provider-kit/process-marker";
import { leaveProcessGroup } from "@ace/provider-kit/process-signal";
import {
  captureTree,
  liveMembers,
  memberOf,
  signalTreeMember,
  stopMembers,
  systemTreeIo,
  type TreeIo,
  type TreeMember,
} from "@ace/provider-kit/process-tree";
import type { z } from "zod";
import { accessRequest } from "../client-access.ts";
import { signallable } from "../owned-evidence.ts";
import { parseRunMarker, RUN_MARKER_FILE } from "../run-marker.ts";
import { ShutdownAdmission, ShutdownReceipt, readShutdownReceipt } from "../shutdown-receipt.ts";
import { timeoutMs, validateArgs, type Args } from "./args.ts";
import { hostConnection } from "./daemon-endpoint.ts";
import { result } from "./io.ts";
import { CliFailure } from "./output.ts";

/*
 * `ace stop` (`ace daemon stop`): stop the daemon serving this home and prove it. A receipt
 * says the daemon's cleanup finished; it can't say the process exited or that nothing it
 * started lives on. So, before the request, this reads the daemon's pid and run id (its home's
 * run marker) and what the home's own records say the run owns, and after the receipt each
 * must be gone.
 *
 * Nothing is signalled for being below the daemon. Evidence is: a process group the inventory
 * records for this daemon process and the tree below it, a process this run's watch recorded,
 * or this run's marker. Then `owned-evidence.ts` spares kept processes, other ace daemons and
 * everything below them, and this command's own chain. One deadline, `--timeout`, bounds it
 * all: the request, the receipt, the daemon's exit and the sweep.
 */

/** At most this much of `--timeout` is kept for SIGTERM to an older daemon, and its exit. */
const FALLBACK_MS = 3_000;

type Receipt = z.infer<typeof ShutdownReceipt>;
type Daemon = TreeMember & { owner: string | undefined };

/** What the stop saw, for the verdict: pure, so every outcome is one table of cases. */
export type StopFacts = {
  receipt: Receipt;
  daemon: "unknown" | "exited" | "running";
  daemonPid?: number;
  /** Processes of the run still running after the sweep. */
  survivors: readonly TreeMember[];
  /** Whether every record of the run could be read whole. */
  complete: boolean;
};

export type StopVerdict =
  | { outcome: "ok" | "failed"; value: unknown }
  | { outcome: "uncertain" | "failed"; message: string; evidence: unknown };

/** The outcome `ace stop` reports. Never "stopped" while anything of the run is unaccounted. */
export function stopVerdict(facts: StopFacts, home: string, leftovers = 0): StopVerdict {
  const { receipt } = facts;
  if (facts.daemon === "unknown")
    return {
      outcome: "uncertain",
      message:
        "The daemon finished its shutdown, but ace couldn't find its process to check that it exited",
      evidence: { receipt },
    };
  if (facts.daemon === "running")
    return {
      outcome: "failed",
      message: `The daemon for ${home} is still running (pid ${facts.daemonPid ?? "unknown"}) after its shutdown`,
      evidence: { receipt, pid: facts.daemonPid },
    };
  if (facts.survivors.length)
    return {
      outcome: "failed",
      message: `${facts.survivors.length} process${facts.survivors.length === 1 ? "" : "es"} the daemon started ${facts.survivors.length === 1 ? "is" : "are"} still running: ${facts.survivors.map((member) => member.pid).join(", ")}`,
      evidence: { receipt, pids: facts.survivors.map((member) => member.pid) },
    };
  if (!facts.complete || receipt.unaccounted)
    return {
      outcome: "uncertain",
      message:
        "The daemon stopped, but it couldn't account for every process it started; some may still run",
      evidence: { receipt },
    };
  return {
    outcome: receipt.state === "succeeded" ? "ok" : "failed",
    value: {
      stopped: receipt.state === "succeeded",
      receipt,
      ...(leftovers ? { leftoversStopped: leftovers } : {}),
    },
  };
}

export async function stopCommand(
  args: Args,
  home: string,
  io: TreeIo = systemTreeIo,
  listing: ProcessListing = systemListing,
) {
  validateArgs(args, [], 1);
  const connection = hostConnection(home);
  const total = timeoutMs(args);
  const deadline = performance.now() + total;
  // The last slice of the deadline is kept for the fallback signal an older daemon needs.
  const politeDeadline = deadline - Math.min(FALLBACK_MS, total / 4);
  const remaining = () => Math.max(0, deadline - performance.now());
  const journal = join(home, "processes.sqlite");
  // Before the request: once shutdown begins, the records it reads start to change.
  const daemon = runningDaemon(home, io);
  const ownChain = [...lineage(process.pid, listing)].flatMap((pid) => memberOf(pid, io) ?? []);
  // A command run from a provider's shell is in that provider's group, which the daemon's
  // shutdown signals as a whole: out of it, this command lives to read the receipt.
  if (daemon && ownChain.some((member) => member.pid === daemon.pid)) leaveProcessGroup();
  let evidence: TreeMember[] = [];
  let complete = true;
  if (daemon) {
    try {
      const leaders = liveMembers(readOwnedGroups(journal, daemon), io);
      const tree = captureTree(
        leaders.map((leader) => leader.pid),
        io,
      );
      complete = !tree.truncated;
      evidence = [
        ...leaders,
        ...tree.members.map(({ pid, start }) => ({ pid, start })),
        ...readOwnership(journal, daemon.owner).escapees,
      ];
    } catch {
      complete = false;
    }
  }
  const admission = ShutdownAdmission.parse(
    await accessRequest(connection.origin, "/v1/stop", {
      method: "POST",
      token: connection.token,
      body: { caller: ownChain },
      timeoutMs: remaining(),
    }),
  );
  const receipt = await receiptFor(home, admission, deadline);
  let state: StopFacts["daemon"] = daemon ? "running" : "unknown";
  if (daemon) {
    // An older daemon closes on a request but leaves its process running; a signal ends it.
    // Windows has no polite signal, and its daemon exits on its own, so it waits it all out.
    const fallback = io.platform !== "win32";
    if (await exited(daemon, io, fallback ? politeDeadline : deadline)) state = "exited";
    else if (fallback && remaining() > 0) {
      signalTreeMember(daemon, "SIGTERM", io);
      if (await exited(daemon, io, deadline)) state = "exited";
    }
  }
  // Whatever of the run outlived its daemon is this home's to end now, by evidence only.
  let leftovers: TreeMember[] = [];
  let survivors: TreeMember[] = [];
  if (state === "exited" && daemon) {
    const found = new Map(liveMembers(evidence, io).map((member) => [member.pid, member]));
    const add = (members: readonly TreeMember[]) => {
      for (const member of members) if (!found.has(member.pid)) found.set(member.pid, member);
    };
    if (daemon.owner) add(markedProcesses(daemon.owner, listing));
    let kept: TreeMember[] = [];
    try {
      const records = readOwnership(journal, daemon.owner);
      kept = records.kept;
      // macOS: what the run's processes started, traced by lineage from the ids it recorded.
      add(lineageDescendants(records.lineage, listing) ?? []);
    } catch {
      complete = false;
    }
    const allowed = signallable(listing, {
      self: daemon,
      spare: new Set(ownChain.map((member) => member.pid)),
      kept,
    });
    leftovers = [...found.values()].filter(allowed);
    survivors = leftovers.length ? await stopMembers(leftovers, 500, io, deadline) : [];
  }
  const verdict = stopVerdict(
    { receipt, daemon: state, ...(daemon ? { daemonPid: daemon.pid } : {}), survivors, complete },
    home,
    leftovers.length,
  );
  if ("message" in verdict)
    throw new CliFailure(verdict.outcome, verdict.message, verdict.evidence, {
      code: verdict.outcome === "failed" ? "failed" : "uncertain",
      hint: "See what's wrong with ace doctor.",
    });
  return result(args, verdict.value, verdict.outcome);
}

/** The daemon this home's run marker names as running, if that process is alive. */
function runningDaemon(home: string, io: TreeIo): Daemon | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(home, RUN_MARKER_FILE), "utf8"));
  } catch {
    return undefined;
  }
  const marker = parseRunMarker(parsed);
  if (marker?.state !== "running") return undefined;
  const member = memberOf(marker.pid, io);
  return member && { ...member, owner: marker.owner };
}

async function receiptFor(
  home: string,
  admission: z.infer<typeof ShutdownAdmission>,
  deadline: number,
): Promise<Receipt> {
  while (performance.now() < deadline) {
    let receipt: Receipt | undefined;
    try {
      receipt = readShutdownReceipt(home);
    } catch {
      throw new CliFailure(
        "uncertain",
        "Shutdown accepted but its completion receipt is unavailable",
        admission,
      );
    }
    if (receipt?.id === admission.receiptId && receipt.state !== "pending") return receipt;
    await delay(Math.min(100, Math.max(1, deadline - performance.now())));
  }
  throw new CliFailure(
    "uncertain",
    "Shutdown accepted but cleanup completion is unconfirmed",
    admission,
  );
}

/** Whether `daemon` has exited by `deadline`. */
async function exited(daemon: TreeMember, io: TreeIo, deadline: number): Promise<boolean> {
  while (liveMembers([daemon], io).length) {
    if (performance.now() >= deadline) return false;
    await io.wait(Math.min(50, Math.max(1, deadline - performance.now())));
  }
  return true;
}
