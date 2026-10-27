/** Journal owner of compactions the automatic space reclaim starts. */
export const SPACE_RECLAIMER = "storage:reclaim";

export interface SpaceReclaimTiming {
  /** First check after startup, so recovery and the first syncs run without it. */
  startupMs: number;
  /** Steady-state period between checks. */
  intervalMs: number;
  /** Writes are counted over this window right before a run, to skip busy moments. */
  probeMs: number;
  /** More than this many commits in the probe window counts as heavy write load. */
  busyTransactions: number;
  /** Retry after a busy probe. */
  busyMs: number;
  /** Next run when a bounded run left free pages behind. */
  continueMs: number;
  /** Retry after a failed run. */
  retryMs: number;
  /** Longest single timer; the due time is rechecked so clock jumps and sleep are harmless. */
  recheckMs: number;
  /** incremental_vacuum chunks per run; writers wait for at most one run. */
  chunksPerRun: number;
}
export const spaceReclaimTiming: SpaceReclaimTiming = {
  startupMs: 10 * 60_000,
  intervalMs: 4 * 3600_000,
  probeMs: 15_000,
  busyTransactions: 60,
  busyMs: 5 * 60_000,
  continueMs: 1_000,
  retryMs: 30 * 60_000,
  recheckMs: 5 * 60_000,
  // 16 chunks of 256 pages: 16 MiB of 4 KiB pages per run.
  chunksPerRun: 16,
};

const MiB = 1024 * 1024;

/**
 * Free pages are worth returning when they are a lot of disk (64 MiB) or a large share of
 * the file (10%). Below 1 MiB nothing is done: ordinary writes reuse those pages anyway.
 */
export function worthReclaiming(space: { fileBytes: number; freeBytes: number }): boolean {
  if (space.freeBytes < MiB) return false;
  return space.freeBytes >= 64 * MiB || space.freeBytes >= space.fileBytes * 0.1;
}

/** True when the commits seen during the probe window mean the daemon is busy writing. */
export function writesBusy(transactions: number, timing: SpaceReclaimTiming): boolean {
  return transactions > timing.busyTransactions;
}

export type SpaceReclaimOutcome = "idle" | "pending" | "complete" | "busy" | "failed";

/** When the next check is due after one finishes. */
export function nextReclaimDue(
  outcome: SpaceReclaimOutcome,
  now: number,
  timing: SpaceReclaimTiming,
): number {
  switch (outcome) {
    case "pending":
      return now + timing.continueMs;
    case "busy":
      return now + timing.busyMs;
    case "failed":
      return now + timing.retryMs;
    case "idle":
    case "complete":
      return now + timing.intervalMs;
  }
}

/**
 * The first check after a start: never sooner than the startup delay, and no later than it
 * when a compaction was cut short, so an interrupted one resumes soon after the restart.
 */
export function firstReclaimDue(
  stored: number | undefined,
  now: number,
  unfinished: boolean,
  timing: SpaceReclaimTiming,
): number {
  const earliest = now + timing.startupMs;
  if (stored === undefined || unfinished) return earliest;
  return Math.max(stored, earliest);
}
