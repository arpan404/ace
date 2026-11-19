import { z } from "zod";

/** A daemon's threads by owner (threads.ts), and the JS workers its telemetry observed. */
/** A worker's kind: its module's name (`notification-worker` for `…/notification-worker.mjs`). */
export function workerKind(entry: string | undefined): string | undefined {
  const name = entry
    ?.split(/[\\/]/)
    .at(-1)
    ?.replace(/\.[cm]?[jt]s$/, "");
  return name || undefined;
}

/**
 * The live workers of a telemetry snapshot, each with its kind. Every isolate records the
 * modules of the workers it started, so a nested worker's kind is in its parent's sample.
 */
export function observedWorkers<
  T extends { threadId: number; workerEntries: Record<string, string> },
>(main: T, workers: readonly T[]): (T & { kind: string | undefined })[] {
  const entries: Record<string, string> = Object.assign(
    {},
    main.workerEntries,
    ...workers.map((worker) => worker.workerEntries),
  );
  return workers.map((worker) => ({
    ...worker,
    kind: workerKind(entries[String(worker.threadId)]),
  }));
}

/**
 * What the workers alive after the workload break: each kind may stay at most once, and only a
 * kind `allowed` names. A worker of no known kind wasn't announced, so it wasn't measured.
 */
export function settledWorkerViolations(
  kinds: readonly (string | undefined)[],
  allowed: readonly string[],
): string[] {
  const violations: string[] = [];
  const unknown = kinds.filter((kind) => kind === undefined).length;
  if (unknown) violations.push(`settled JS workers: not measured (${unknown} of no known module)`);
  const counts = new Map<string, number>();
  for (const kind of kinds) if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  for (const [kind, count] of counts)
    if (!allowed.includes(kind))
      violations.push(`JS workers after the workload: ${kind} still alive`);
    else if (count > 1)
      violations.push(`JS workers after the workload: ${count} ${kind} workers still alive`);
  return violations;
}

export const ThreadSample = z.object({
  census: z.object({
    total: z.number().int().nonnegative(),
    runtime: z.number().int().nonnegative(),
    workers: z.number().int().nonnegative(),
    own: z.number().int().nonnegative(),
  }),
  workers: z.array(z.object({ kind: z.string().optional() })),
});
export type ThreadSample = z.infer<typeof ThreadSample>;
/** An idle sample also records the fewest JS workers alive across five idle seconds. */
export const IdleThreadSample = ThreadSample.extend({
  workerFloor: z.number().int().nonnegative(),
});
export type IdleThreadSample = z.infer<typeof IdleThreadSample>;

/** The daemon's threads idle, under the workload, and after the workload's sessions ended. */
export interface ThreadPhases {
  idle: IdleThreadSample;
  active: ThreadSample;
  settled: ThreadSample;
}

export interface ThreadLimits {
  /**
   * JS worker threads that stay alive through the startup idle floor. Periodic reuse can grow
   * an idle window up to two minutes; retained workers after the workload are checked by kind.
   */
  idleWorkers: number;
  /** JS worker threads under the workload. */
  activeWorkers: number;
  /**
   * The kinds of worker (workerKind) that may stay, one each, once the workload's sessions
   * ended: the idle ones, services the workload started for good, and idle workers whose idle
   * window the workload grew past the wait.
   */
  settledWorkers: readonly string[];
  /** The daemon's own OS threads (not Bun's runtime, not workers) at idle and when active. */
  idleOwnThreads: number;
  activeOwnThreads: number;
  /**
   * Bun's own threads, idle or active. They grow with the machine's cores, so this is a loose,
   * core-scaled ceiling (runtimeThreadCeiling) that only a runaway pool reaches.
   */
  runtimeThreads: number;
}

/** Twice the cores and 16 more: Bun 1.4.4 held 28-32 runtime threads on 16 cores. */
export function runtimeThreadCeiling(cores: number): number {
  return 2 * cores + 16;
}

/**
 * What the daemon's threads break of its budgets. The OS counts every JS worker; telemetry
 * counts those it can see. When they differ, worker telemetry isn't attached (Bun gives a
 * worker no preload of its parent's), so worker memory and imports went unmeasured: that is a
 * violation, never a silent zero.
 */
export function threadViolations(phases: ThreadPhases, limits: ThreadLimits): string[] {
  const { idle, active, settled } = phases;
  const violations: string[] = [];
  const samples = [
    ["idle", idle],
    ["active", active],
    ["settled", settled],
  ] as const;
  for (const [phase, sample] of samples)
    if (sample.workers.length !== sample.census.workers)
      violations.push(
        `${phase} JS workers: not measured (${sample.census.workers} running, telemetry saw ${sample.workers.length})`,
      );
  if (idle.workerFloor > limits.idleWorkers)
    violations.push(`idle JS workers: ${idle.workerFloor} exceeds ${limits.idleWorkers}`);
  if (active.census.workers > limits.activeWorkers)
    violations.push(`active JS workers: ${active.census.workers} exceeds ${limits.activeWorkers}`);
  // A worker the workload started that its end didn't retire, and that no service accounts for,
  // leaks.
  violations.push(
    ...settledWorkerViolations(
      settled.workers.map((worker) => worker.kind),
      limits.settledWorkers,
    ),
  );
  if (idle.census.own > limits.idleOwnThreads)
    violations.push(`idle daemon threads: ${idle.census.own} exceeds ${limits.idleOwnThreads}`);
  for (const [phase, sample] of samples)
    if (sample.census.runtime > limits.runtimeThreads)
      violations.push(
        `${phase} Bun runtime threads: ${sample.census.runtime} exceeds ${limits.runtimeThreads}`,
      );
  if (active.census.own > limits.activeOwnThreads)
    violations.push(
      `active daemon threads: ${active.census.own} exceeds ${limits.activeOwnThreads}`,
    );
  return violations;
}
