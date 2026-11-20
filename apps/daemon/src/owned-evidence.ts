import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProcessListing } from "@ace/provider-kit/process-listing";
import { carriesKeep } from "@ace/provider-kit/process-marker";
import type { TreeMember } from "@ace/provider-kit/process-tree";
import { parseRunMarker, RUN_MARKER_FILE } from "./run-marker.ts";

/*
 * Which of a sweep's candidates may be signalled. A candidate comes with evidence that it is
 * this run's (its marker, an owned group's tree, a recorded snapshot row); these rules can only
 * take candidates away, never add one. A candidate is spared when it, or any process above it
 * up to this run's daemon, is:
 *
 * - in `spare`: this daemon's own lineage, and the caller of a stop request with its ancestors;
 * - kept: launched to outlive ace (`ACE_PROCESS_KEEP=1`, or a recorded kept pid and start);
 * - another ace daemon. Linux shows a process's environment from when it started, so a daemon
 *   started from this run's agent shell carries this run's marker for its whole life. It, and
 *   everything below it, belong to its own home. A daemon is known by its command line (an ace
 *   entry with `start`, `serve` or `supervise`) or by its home's run marker naming its pid.
 *
 * Above this run's daemon the walk stops: its own ancestors (a terminal, a service manager, or
 * another daemon this one was started from) say nothing about what is below it.
 */

/** The ace entries a daemon runs from: the dev CLI, a release's ace.mjs and its launcher. */
function isAceEntry(arg: string): boolean {
  return (
    /(?:^|\/)apps\/daemon\/src\/cli\.ts$/.test(arg) ||
    basename(arg) === "ace.mjs" ||
    basename(arg) === "ace" ||
    basename(arg) === "ace.cmd"
  );
}
const daemonCommands = new Set(["start", "serve", "supervise"]);

/** Whether an argument list runs an ace daemon (or the supervisor that runs one). */
export function runsAceDaemon(argv: readonly string[]): boolean {
  const entry = argv.findIndex(isAceEntry);
  if (entry < 0) return false;
  const command = argv.slice(entry + 1).find((arg) => !arg.startsWith("-"));
  return command !== undefined && daemonCommands.has(command);
}

export interface Protection {
  /** This run's daemon: the walk up from a candidate stops there. */
  self: TreeMember | undefined;
  /** Pids never to signal: this daemon's lineage, a stop request's caller and its ancestors. */
  spare: ReadonlySet<number>;
  /** Processes ace launched to outlive it. */
  kept: readonly TreeMember[];
  /** Reads a home's run marker; injected so tests can stand in for other homes. */
  readMarker?: (home: string) => unknown;
}

const readMarkerFile = (home: string): unknown => {
  try {
    return JSON.parse(readFileSync(join(home, RUN_MARKER_FILE), "utf8"));
  } catch {
    return undefined;
  }
};

/** A predicate over candidates: true when the rules allow signalling it. */
export function signallable(
  listing: ProcessListing,
  protection: Protection,
): (member: TreeMember) => boolean {
  const kept = new Set(protection.kept.map((member) => `${member.pid}:${member.start}`));
  const readMarker = protection.readMarker ?? readMarkerFile;
  const verdicts = new Map<string, boolean>();
  /** Whether one process (not its ancestors) stops a sweep. */
  const shielded = (pid: number, start: string): boolean => {
    if (protection.spare.has(pid) || kept.has(`${pid}:${start}`)) return true;
    const environment = listing.environment(pid);
    if (environment && carriesKeep(environment)) return true;
    const argv = listing.arguments(pid);
    if (argv && runsAceDaemon(argv)) return true;
    const home = environment
      ?.find((entry) => entry.startsWith("ACE_HOME="))
      ?.slice("ACE_HOME=".length);
    if (home) {
      const marker = parseRunMarker(readMarker(home));
      if (marker?.state === "running" && marker.pid === pid) return true;
    }
    return false;
  };
  return (member) => {
    const path: string[] = [];
    let verdict = true;
    let current: TreeMember | undefined = member;
    for (let depth = 0; current && depth < 64; depth++) {
      const key = `${current.pid}:${current.start}`;
      const known = verdicts.get(key);
      if (known !== undefined) {
        verdict = known;
        break;
      }
      if (protection.self?.pid === current.pid && protection.self.start === current.start) break;
      path.push(key);
      if (shielded(current.pid, current.start)) {
        verdict = false;
        break;
      }
      const info = listing.info(current.pid);
      const parent: number | undefined =
        info && info.start === current.start ? info.parent : undefined;
      if (parent === undefined || parent <= 1) break;
      const above = listing.info(parent);
      current = above && !above.zombie ? { pid: parent, start: above.start } : undefined;
    }
    for (const key of path) verdicts.set(key, verdict);
    return verdict;
  };
}
