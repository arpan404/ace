/** Monotonic time and a repeating timer, injected so tests drive drift without sleeping. */
export interface LoopClock {
  now(): number;
  every(milliseconds: number, tick: () => void): () => void;
}
export interface LoopStatus {
  /** How late the most recent tick ran, in milliseconds. */
  delayMs: number;
  /** The longest delay since the daemon started. */
  maxDelayMs: number;
  /** Ticks that ran at least `stallMs` late. */
  stalls: number;
}
export interface LoopStall {
  delayMs: number;
  /** Stalls since the previous stall record that were not logged on their own. */
  suppressed: number;
}
export interface LoopMonitorOptions {
  clock: LoopClock;
  onStall(stall: LoopStall): void;
  intervalMs?: number;
  stallMs?: number;
  /** At most one stall record per window, so a busy loop cannot flood the log. */
  logWindowMs?: number;
}

/**
 * Measures event-loop stalls by timer drift: a tick that runs late means the loop was busy.
 * A watchdog reading `status()` can tell a busy daemon (large delays, still answering) from
 * a hung one (no answer at all).
 */
export function createLoopMonitor({
  clock,
  onStall,
  intervalMs = 500,
  stallMs = 1000,
  logWindowMs = 60_000,
}: LoopMonitorOptions) {
  let expected = clock.now() + intervalMs;
  let delayMs = 0;
  let maxDelayMs = 0;
  let stalls = 0;
  let suppressed = 0;
  let loggedAt: number | undefined;
  const stop = clock.every(intervalMs, () => {
    const now = clock.now();
    delayMs = Math.max(0, Math.round(now - expected));
    expected = now + intervalMs;
    maxDelayMs = Math.max(maxDelayMs, delayMs);
    if (delayMs < stallMs) return;
    stalls++;
    if (loggedAt !== undefined && now - loggedAt < logWindowMs) {
      suppressed++;
      return;
    }
    loggedAt = now;
    const stall = { delayMs, suppressed };
    suppressed = 0;
    onStall(stall);
  });
  return {
    status: (): LoopStatus => ({ delayMs, maxDelayMs, stalls }),
    close: stop,
  };
}

export const systemLoopClock: LoopClock = {
  now: () => performance.now(),
  every(milliseconds, tick) {
    const timer = setInterval(tick, milliseconds);
    timer.unref();
    return () => clearInterval(timer);
  },
};
