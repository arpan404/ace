export interface StallDetectorOptions {
  /** Main-thread silence (no heartbeat) that counts as a stall. */
  thresholdMs: number;
  /** While one stall lasts, look again after this much more silence. */
  repeatMs: number;
  /** Looks at one stall at most. */
  maxCaptures: number;
  /**
   * After a capture, a new short stall is not captured again within this window, so frequent
   * small stalls do not interrupt the daemon each time. A stall reaching `repeatMs` always is.
   */
  cooldownMs: number;
}
export type StallObservation =
  | { type: "healthy" }
  | { type: "stalled"; silentMs: number; capture: boolean }
  | { type: "recovered"; silentMs: number };

/**
 * Decides, from the watchdog's own monotonic clock and the main thread's heartbeat counter,
 * when the main thread is stuck and when to look at where. Pure: the caller feeds every check.
 */
export function createStallDetector(options: StallDetectorOptions) {
  let beat: number | undefined;
  let changedAt = 0;
  let checkedAt: number | undefined;
  let stalled = false;
  let captures = 0;
  let capturedSilentMs = 0;
  let lastCaptureAt: number | undefined;
  return {
    observe(now: number, heartbeat: number): StallObservation {
      const previousCheck = checkedAt;
      checkedAt = now;
      if (beat !== heartbeat || previousCheck === undefined) {
        const recovered = stalled ? Math.round(now - changedAt) : undefined;
        beat = heartbeat;
        changedAt = now;
        stalled = false;
        captures = 0;
        return recovered === undefined
          ? { type: "healthy" }
          : { type: "recovered", silentMs: recovered };
      }
      // The watchdog itself did not run over that gap (the process was descheduled, or the
      // machine slept): the missing heartbeats say nothing about the main thread yet.
      if (!stalled && now - previousCheck >= options.thresholdMs) changedAt = now;
      const silentMs = Math.round(now - changedAt);
      if (silentMs < options.thresholdMs) return { type: "healthy" };
      stalled = true;
      const first =
        captures === 0 &&
        (lastCaptureAt === undefined ||
          now - lastCaptureAt >= options.cooldownMs ||
          silentMs >= options.repeatMs);
      const again = captures > 0 && silentMs - capturedSilentMs >= options.repeatMs;
      const capture = captures < options.maxCaptures && (first || again);
      if (capture) {
        captures++;
        capturedSilentMs = silentMs;
        lastCaptureAt = now;
      }
      return { type: "stalled", silentMs, capture };
    },
  };
}
