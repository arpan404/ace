import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessListing } from "@ace/provider-kit/process-listing";
import type { TreeMember } from "@ace/provider-kit/process-tree";
import { parseRunMarker, RUN_MARKER_FILE } from "./run-marker.ts";

/*
 * Which of a sweep's candidates may be signalled. A candidate comes with evidence that it is
 * this run's (its marker, an owned group's tree, a recorded row, its lineage); these rules can
 * only take candidates away, never add one. A candidate is spared when it is in `spare` (this
 * daemon's own lineage, and a stop request's verified caller and its shell: those processes
 * alone, not what they started), or when it, or any process above it up to this run's daemon,
 * is:
 *
 * - kept: a process ace recorded, by pid and start, as it launched it to outlive ace (the
 *   updater, an editor, a sign-in browser). An environment variable proves nothing here: any
 *   process can set one;
 * - another ace daemon. Linux shows the environment a process started with, so a daemon started
 *   from this run's agent shell carries this run's marker for its whole life. It, and all below
 *   it, belong to its own home. It is known only by its own home's run marker naming its pid AND
 *   kernel start: never by its command line, which anything can imitate. (A daemon from a build
 *   whose run marker records no kernel start can't be told apart.)
 *
 * Above this run's daemon the walk stops: its own ancestors (a terminal, a service manager, or
 * another daemon this one was started from) say nothing about what is below it.
 */

export interface Protection {
  /** This run's daemon: the walk up from a candidate stops there. */
  self: TreeMember | undefined;
  /** Pids never to signal: this daemon's lineage, a stop request's verified caller chain. */
  spare: ReadonlySet<number>;
  /** Processes ace recorded as it launched them to outlive it. */
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

/** The home a process's start environment names: its ACE_HOME, else its HOME's `.ace`. */
function homeNamed(environment: readonly string[]): string | undefined {
  const value = (name: string) =>
    environment.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  const home = value("ACE_HOME");
  if (home) return home;
  const person = value("HOME");
  return person ? join(person, ".ace") : undefined;
}

/** A predicate over candidates: true when the rules allow signalling it. */
export function signallable(
  listing: ProcessListing,
  protection: Protection,
): (member: TreeMember) => boolean {
  const kept = new Set(protection.kept.map((member) => `${member.pid}:${member.start}`));
  const readMarker = protection.readMarker ?? readMarkerFile;
  const verdicts = new Map<string, boolean>();
  /** Whether a running ace daemon of some home is exactly this process. */
  const isDaemon = (pid: number, start: string): boolean => {
    const environment = listing.environment(pid);
    const home = environment && homeNamed(environment);
    if (!home) return false;
    const marker = parseRunMarker(readMarker(home));
    return marker?.state === "running" && marker.pid === pid && marker.start === start;
  };
  /** Whether one process protects itself and all below it. */
  const shielded = (pid: number, start: string): boolean =>
    kept.has(`${pid}:${start}`) || isDaemon(pid, start);
  return (member) => {
    // Spared processes are spared themselves; what they started is judged on its own.
    if (protection.spare.has(member.pid)) return false;
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
