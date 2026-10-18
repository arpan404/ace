/**
 * Retry policy for a pinned live-write batch that failed to commit. Pure: the buffer owns the
 * timer, the stream owns the decision.
 *
 * Every failed attempt waits twice as long as the one before, from 100 ms to a 5 s cap. Real
 * contention (SQLITE_BUSY/LOCKED) retries for as long as it lasts. Any other failure is
 * deterministic more often than not, so after a bounded number of attempts the batch is split
 * by thread and only the threads whose rows still fail are quarantined.
 */
export const liveWriteRetry = { baseMs: 100, capMs: 5_000, quarantineAfter: 6 } as const;

/** Delay before the attempt that follows the `failures`-th consecutive failure (1-based). */
export function liveWriteRetryDelay(failures: number): number {
  const step = Math.max(0, Math.min(failures - 1, 16));
  return Math.min(liveWriteRetry.capMs, liveWriteRetry.baseMs * 2 ** step);
}
