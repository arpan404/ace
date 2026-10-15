export interface WatchdogOptions {
  /** Pause between one check's outcome and the next check. */
  intervalMs: number;
  /** How long a check waits for an answer before it counts as missed. */
  timeoutMs: number;
  /** Missed checks in a row before the daemon is treated as unresponsive. */
  failures: number;
  /** Asks the daemon once; true when it answered healthy. */
  probe(): Promise<boolean>;
  timers: { set(delayMs: number, callback: () => void): () => void };
  log(level: "info" | "warn", message: string, data: Record<string, unknown>): void;
  /** Called once, after `failures` missed checks in a row. The watchdog has stopped by then. */
  onUnresponsive(missed: number): void;
}

/**
 * Watches a running daemon's health. A check that is answered late but healthy, even after
 * it was counted as missed, resets the count: a busy daemon is slow, not gone. Only one probe
 * is ever in flight; a check that finds the previous probe still pending waits on it again
 * rather than sending another. Returns a function that stops the watch.
 */
export function watchHealth(options: WatchdogOptions): () => void {
  let stopped = false;
  let missed = 0;
  let inFlight: Promise<boolean> | undefined;
  /** The probe last counted as missed: if it still answers healthy, the count resets. */
  let late: Promise<boolean> | undefined;
  let cancel: (() => void) | undefined;

  const next = () => {
    if (stopped) return;
    cancel = options.timers.set(options.intervalMs, () => {
      cancel = undefined;
      check();
    });
  };
  const send = (): Promise<boolean> => {
    const probe = options.probe().catch(() => false);
    inFlight = probe;
    void probe.then((ok) => {
      if (inFlight === probe) inFlight = undefined;
      if (late !== probe) return;
      late = undefined;
      if (!ok || stopped || missed === 0) return;
      options.log("info", "The daemon answered a late health check", { missed });
      missed = 0;
    });
    return probe;
  };
  const check = () => {
    if (stopped) return;
    const probe = inFlight ?? send();
    let settled = false;
    const outcome = (answer: boolean | "timeout") => {
      if (settled || stopped) return;
      settled = true;
      cancel?.();
      cancel = undefined;
      if (answer === true) {
        if (missed > 0)
          options.log("info", "The daemon answered its health check again", { missed });
        missed = 0;
        next();
        return;
      }
      if (answer === "timeout") late = probe;
      missed++;
      options.log("warn", "The daemon missed a health check", {
        missed,
        of: options.failures,
        reason: answer === "timeout" ? "no answer" : "unhealthy answer",
        timeoutMs: options.timeoutMs,
      });
      if (missed < options.failures) return next();
      stopped = true;
      options.onUnresponsive(missed);
    };
    cancel = options.timers.set(options.timeoutMs, () => {
      cancel = undefined;
      outcome("timeout");
    });
    void probe.then(outcome);
  };

  next();
  return () => {
    stopped = true;
    cancel?.();
    cancel = undefined;
  };
}
