import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lineage, systemListing, type ProcessListing } from "@ace/provider-kit/process-listing";
import { markedProcesses } from "@ace/provider-kit/process-marker";
import {
  captureDescendants,
  liveMembers,
  memberOf,
  stopMembers,
  systemTreeIo,
  type TreeIo,
  type TreeMember,
} from "@ace/provider-kit/process-tree";
import { accessRequest } from "../client-access.ts";
import { parseRunMarker, RUN_MARKER_FILE } from "../run-marker.ts";
import type { z } from "zod";
import { ShutdownAdmission, ShutdownReceipt, readShutdownReceipt } from "../shutdown-receipt.ts";
import { timeoutMs, validateArgs, type Args } from "./args.ts";
import { hostConnection } from "./daemon-endpoint.ts";
import { result } from "./io.ts";
import { CliFailure } from "./output.ts";

/*
 * `ace stop` (`ace daemon stop`): stop the daemon serving this home and prove it. A receipt
 * says the daemon's cleanup finished; it can't say the process exited or that nothing it
 * started lives on. So the daemon's pid (from this home's run marker) and every process below
 * it are captured before the request, and after the receipt each must be gone. Another home's
 * daemon is never reached: its pid isn't in this home's marker and its processes aren't
 * below this one.
 */

/** After its receipt, how long the daemon gets to exit; its own hard limit is 7.5 s. */
const exitWaitMs = 10_000;
/** The least an older daemon gets to exit after SIGTERM, whatever is left of --timeout. */
const signalWaitMs = 2_000;

type Receipt = z.infer<typeof ShutdownReceipt>;

export async function stopCommand(
  args: Args,
  home: string,
  io: TreeIo = systemTreeIo,
  listing: ProcessListing = systemListing,
) {
  validateArgs(args, [], 1);
  const connection = hostConnection(home);
  const bound = timeoutMs(args);
  const deadline = performance.now() + bound;
  const signal = AbortSignal.timeout(bound);
  // Before the request: once shutdown begins, a child that left its group loses its parent.
  const daemon = runningDaemon(home, io);
  let tree: TreeMember[] | undefined;
  try {
    tree = daemon
      ? captureDescendants([daemon.pid], io).map(({ pid, start }) => ({ pid, start }))
      : [];
  } catch {
    tree = undefined;
  }
  const admission = ShutdownAdmission.parse(
    await accessRequest(connection.origin, "/v1/stop", { method: "POST", token: connection.token }),
  );
  const receipt = await receiptFor(home, admission, signal);
  if (!daemon)
    throw new CliFailure(
      "uncertain",
      "The daemon finished its shutdown, but ace couldn't find its process to check that it exited",
      { receipt },
    );
  const remaining = () => Math.max(0, deadline - performance.now());
  if (!(await exited(daemon, io, Math.min(exitWaitMs, remaining())))) {
    // An older daemon closes on a request but leaves its process running; a signal ends it.
    // Windows has no polite signal, and its daemon exits on its own.
    if (io.platform !== "win32") signalSame(daemon, io);
    if (!(await exited(daemon, io, Math.max(signalWaitMs, Math.min(exitWaitMs, remaining())))))
      throw new CliFailure(
        "failed",
        `The daemon for ${home} is still running (pid ${daemon.pid}) after its shutdown`,
        { receipt, pid: daemon.pid },
        { code: "failed", hint: "See what's wrong with ace doctor." },
      );
  }
  // The daemon stops what it started; whatever outlived it is this home's to end now: what was
  // below it, and what carries its run's marker (an orphan no tree reaches). Never this
  // command or what runs it (an agent's shell may be running `ace stop`).
  const spare = lineage(process.pid, listing);
  const found = new Map<number, TreeMember>();
  for (const member of tree ? liveMembers(tree, io) : []) found.set(member.pid, member);
  for (const pid of daemon.owner ? markedProcesses(daemon.owner, listing) : []) {
    const member = found.has(pid) ? undefined : memberOf(pid, io);
    if (member) found.set(pid, member);
  }
  const leftovers = [...found.values()].filter((member) => !spare.has(member.pid));
  const survivors = leftovers.length ? await stopMembers(leftovers, 500, io) : [];
  if (survivors.length)
    throw new CliFailure(
      "failed",
      `${survivors.length} process${survivors.length === 1 ? "" : "es"} the daemon started ${survivors.length === 1 ? "is" : "are"} still running: ${survivors.map((member) => member.pid).join(", ")}`,
      { receipt, pids: survivors.map((member) => member.pid) },
      { code: "failed", hint: "See what's wrong with ace doctor." },
    );
  if (!tree)
    throw new CliFailure(
      "uncertain",
      "The daemon stopped, but ace couldn't read its process tree to check what it started",
      { receipt },
    );
  return result(
    args,
    {
      stopped: receipt.state === "succeeded",
      receipt,
      ...(leftovers.length ? { leftoversStopped: leftovers.length } : {}),
    },
    receipt.state === "succeeded" ? "ok" : "failed",
  );
}

/** The daemon this home's run marker names as running, if that process is alive. */
function runningDaemon(
  home: string,
  io: TreeIo,
): (TreeMember & { owner: string | undefined }) | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(home, RUN_MARKER_FILE), "utf8"));
  } catch {
    return undefined;
  }
  const marker = parseRunMarker(parsed);
  if (marker?.state !== "running") return undefined;
  try {
    const identity = io.identity(marker.pid);
    return identity && { pid: marker.pid, start: identity.start, owner: marker.owner };
  } catch {
    return undefined;
  }
}

async function receiptFor(
  home: string,
  admission: z.infer<typeof ShutdownAdmission>,
  signal: AbortSignal,
): Promise<Receipt> {
  while (!signal.aborted) {
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
    await delay(100, undefined, { signal }).catch(() => {});
  }
  throw new CliFailure(
    "uncertain",
    "Shutdown accepted but cleanup completion is unconfirmed",
    admission,
  );
}

async function exited(daemon: TreeMember, io: TreeIo, milliseconds: number): Promise<boolean> {
  for (let waited = 0; waited < milliseconds; waited += 50) {
    if (!liveMembers([daemon], io).length) return true;
    await io.wait(50);
  }
  return !liveMembers([daemon], io).length;
}

/** SIGTERM to the daemon, only while its pid is still that same process. */
function signalSame(daemon: TreeMember, io: TreeIo): void {
  if (!liveMembers([daemon], io).length) return;
  try {
    io.signal(daemon.pid, "SIGTERM");
  } catch {
    /* It exited between the check and the signal. */
  }
}
