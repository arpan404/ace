import { StorageRetention, type StorageKind } from "@ace/protocol";

/** Reviewer identity of automatic retention plans in the cleanup journal. */
export const RETENTION_REVIEWER = "storage:retention";
/** Data the retention window governs. Worktrees, caches and artifacts keep reviewed cleanup. */
export const retentionKinds = ["threads", "attachments", "logs"] as const satisfies StorageKind[];

/** The cleanup policy one retention window implies. */
export function retentionPolicy(days: number): StorageRetention {
  return StorageRetention.parse({
    threads: days,
    attachments: days,
    logs: days,
    artifacts: null,
    worktrees: null,
    caches: null,
    idleThreads: true,
  });
}

export interface RetentionTiming {
  /** First pass after startup, so recovery and listeners settle first. */
  startupMs: number;
  /** Steady-state period between passes. */
  intervalMs: number;
  /** A shorter window applies this soon after it is saved. */
  changeMs: number;
  /** Retry after a pass that left eligible work behind or failed. */
  retryMs: number;
}
export const retentionTiming: RetentionTiming = {
  startupMs: 30_000,
  intervalMs: 6 * 3600_000,
  changeMs: 2_000,
  retryMs: 60_000,
};

/** When the next pass runs after a window change. Only a shorter window brings it forward. */
export function delayAfterChange(
  previous: number | undefined,
  next: number,
  timing: RetentionTiming,
): number | undefined {
  if (previous === undefined) return timing.startupMs;
  return next < previous ? timing.changeMs : undefined;
}

/** When the next pass runs after one finishes. */
export function delayAfterPass(
  outcome: { complete: boolean } | "failed",
  timing: RetentionTiming,
): number {
  return outcome === "failed" || !outcome.complete ? timing.retryMs : timing.intervalMs;
}
