import type { Listener } from "@ace/preview/detection";

/*
 * Pure rules for the background command port probe (ADR 0109): which listening ports belong to
 * a command, and how often to look again. The OS tables are read by `probe.ts`.
 */

/** A running background command the probe watches: its output file finds its processes. */
export interface PortCandidate {
  taskId: string;
  outputPath: string;
  /** Its agent's turn finished, so a port would release the thread (only then is it probed). */
  turnFinished: boolean;
  /** The ports last reported for it. */
  listening: readonly number[];
}

/**
 * The ports a command's processes listen on. `holders` are the processes that have its output
 * file open (the shell and everything that inherited its output); a listener counts when it is
 * one of them or descends from one, so a server that redirected its own output still counts
 * while its parent shell holds the file. Sorted, without repeats.
 */
export function taskPorts(
  listeners: readonly Listener[],
  parents: ReadonlyMap<number, number>,
  holders: ReadonlySet<number>,
): number[] {
  if (!holders.size) return [];
  const owned = (pid: number): boolean => {
    const seen = new Set<number>();
    for (let at: number | undefined = pid; at !== undefined && at > 1; at = parents.get(at)) {
      if (holders.has(at)) return true;
      if (seen.has(at)) return false;
      seen.add(at);
    }
    return false;
  };
  const ports = new Set<number>();
  for (const listener of listeners) if (owned(listener.pid)) ports.add(listener.port);
  return [...ports].toSorted((a, b) => a - b);
}

/** Whether a probe's answer differs from what was last reported. */
export function portsChanged(before: readonly number[], after: readonly number[]): boolean {
  return before.length !== after.length || before.some((port, i) => port !== after[i]);
}

/**
 * How long to wait before probing a thread again, by how many probes ran since its last change:
 * servers take a few seconds to bind, so look soon after a turn ends, then back off to a minute.
 */
export function nextProbeDelay(probesSinceChange: number): number {
  const steps = [2_000, 4_000, 8_000, 15_000, 30_000];
  return steps[probesSinceChange] ?? 60_000;
}
