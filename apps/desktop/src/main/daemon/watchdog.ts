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
  /** Monotonic milliseconds, to tell when this process's own timers ran late. */
  now(): number;
  /**
   * How late this process's timers may run before a check is treated as the app freezing
   * rather than the daemon missing it. Default 2 s.
   */
  lateToleranceMs?: number;
  log(level: "info" | "warn", message: string, data: Record<string, unknown>): void;
  /** Called once, after `failures` missed checks in a row. The watchdog has stopped by then. */
  onUnresponsive(missed: number): void;
}

/** How often the watch beats, to notice the app's own main thread freezing. */
const BEAT_MS = 500;

/**
 * Watches a running daemon's health. A check that is answered late but healthy, even after
 * it was counted as missed, resets the count: a busy daemon is slow, not gone. Only one probe
 * is ever in flight; a check that finds the previous probe still pending waits on it again
 * rather than sending another.
 *
 * The checks run on this process's timers, so a frozen app sees every one of them late: a
 * timeout fires long after its deadline and a request's own abort beats the answer that waited
 * unread in the socket. Neither says anything about the daemon. A check during which the
 * app's timers ran late is not counted; it is sent again once the app runs. Only checks the
 * app saw on time can stop a daemon. Returns a function that stops the watch.
 */
export function watchHealth(options: WatchdogOptions): () => void {
  let stopped = false;
  let missed = 0;
  let inFlight: Promise<boolean> | undefined;
  /** The probe last counted as missed: if it still answers healthy, the count resets. */
  let late: Promise<boolean> | undefined;
  let cancel: (() => void) | undefined;
  const tolerance = options.lateToleranceMs ?? 2_000;
  /** When the app was last seen coming back from a freeze. */
  let thawedAt: number | undefined;
  let frozenMs = 0;
  let beatAt = options.now();
  let cancelBeat: (() => void) | undefined;
  const beat = () => {
    const now = options.now();
    const gap = now - beatAt - BEAT_MS;
    if (gap > tolerance) {
      thawedAt = now;
      frozenMs = Math.round(gap);
    }
    beatAt = now;
    if (!stopped) cancelBeat = options.timers.set(BEAT_MS, beat);
  };
  cancelBeat = options.timers.set(BEAT_MS, beat);
  /** When the in-flight probe was sent. */
  let sentAt = 0;

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
    sentAt = options.now();
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
    const startedAt = options.now();
    const probe = inFlight ?? send();
    const since = Math.min(startedAt, sentAt);
    let settled = false;
    const outcome = (answer: boolean | "timeout") => {
      if (settled || stopped) return;
      settled = true;
      cancel?.();
      cancel = undefined;
      const now = options.now();
      const timeoutLateMs = answer === "timeout" ? now - startedAt - options.timeoutMs : 0;
      if (answer !== true && (timeoutLateMs > tolerance || (thawedAt ?? -1) >= since)) {
        options.log("info", "The app froze during a daemon health check; checking again", {
          frozenMs: Math.round(Math.max(frozenMs, timeoutLateMs)),
          missed,
        });
        // After the I/O the freeze held back: an answer waiting in the socket counts.
        cancel = options.timers.set(0, () => {
          cancel = undefined;
          check();
        });
        return;
      }
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
    cancelBeat?.();
  };
}
