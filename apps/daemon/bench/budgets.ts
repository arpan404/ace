import { z } from "zod";

/** A daemon's threads by owner (threads.ts), and the JS workers its telemetry observed. */
export const ThreadSample = z.object({
  census: z.object({
    total: z.number().int().nonnegative(),
    runtime: z.number().int().nonnegative(),
    workers: z.number().int().nonnegative(),
    own: z.number().int().nonnegative(),
  }),
  workers: z.array(z.unknown()),
});
export type ThreadSample = z.infer<typeof ThreadSample>;
/** An idle sample also records the fewest JS workers alive across five idle seconds. */
export const IdleThreadSample = ThreadSample.extend({
  workerFloor: z.number().int().nonnegative(),
});
export type IdleThreadSample = z.infer<typeof IdleThreadSample>;

export interface ThreadLimits {
  /**
   * JS worker threads that stay alive at idle. Idle workers retire after five idle seconds, so
   * the fewest alive across five seconds is what is held to it.
   */
  idleWorkers: number;
  /** The daemon's own OS threads (not Bun's runtime, not workers) at idle and when active. */
  idleOwnThreads: number;
  activeOwnThreads: number;
}

/**
 * What the daemon's threads break of its budgets. The OS counts every JS worker; telemetry
 * counts those it can see. When they differ, worker telemetry isn't attached (Bun gives a
 * worker no preload of its parent's), so worker memory and imports went unmeasured: that is a
 * violation, never a silent zero.
 */
export function threadViolations(
  idle: IdleThreadSample,
  active: ThreadSample,
  limits: ThreadLimits,
): string[] {
  const violations: string[] = [];
  for (const [phase, sample] of [
    ["idle", idle],
    ["active", active],
  ] as const)
    if (sample.workers.length !== sample.census.workers)
      violations.push(
        `${phase} JS workers: not measured (${sample.census.workers} running, telemetry saw ${sample.workers.length})`,
      );
  if (idle.workerFloor > limits.idleWorkers)
    violations.push(`idle JS workers: ${idle.workerFloor} exceeds ${limits.idleWorkers}`);
  if (idle.census.own > limits.idleOwnThreads)
    violations.push(`idle daemon threads: ${idle.census.own} exceeds ${limits.idleOwnThreads}`);
  if (active.census.own > limits.activeOwnThreads)
    violations.push(
      `active daemon threads: ${active.census.own} exceeds ${limits.activeOwnThreads}`,
    );
  return violations;
}
