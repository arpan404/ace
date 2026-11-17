/**
 * Bounded backoff for the process inventory's own writes, which run on the main thread from
 * timers and exit listeners where a throw would end the daemon. Pure apart from the injected
 * clock: the inventory owns the timers.
 */

/** Delay before the next attempt after `failures` consecutive failures (1-based). */
export function inventoryRetryMs(failures: number, baseMs = 1_000, capMs = 30_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, Math.min(failures - 1, 16)));
}

/**
 * A recorder tick that never throws. A failed `step` is reported and the next attempts back
 * off; ticks in between do nothing. `step` returning false means there is nothing left to
 * record, and `stop` runs.
 */
export function guardedTick(
  step: () => boolean,
  options: { now(): number; report(error: unknown): void; stop(): void },
): () => void {
  let failures = 0;
  let retryAt = Number.NEGATIVE_INFINITY;
  return () => {
    const now = options.now();
    if (now < retryAt) return;
    let more: boolean;
    try {
      more = step();
    } catch (error) {
      failures++;
      retryAt = now + inventoryRetryMs(failures);
      options.report(error);
      return;
    }
    failures = 0;
    retryAt = Number.NEGATIVE_INFINITY;
    if (!more) options.stop();
  };
}
