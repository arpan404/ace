import { logError, logFields } from "@ace/diagnostics";

export interface FatalEvents {
  on(event: "uncaughtExceptionMonitor", listener: (error: unknown) => void): unknown;
  on(event: "exit", listener: () => void): unknown;
  off(event: "uncaughtExceptionMonitor", listener: (error: unknown) => void): unknown;
  off(event: "exit", listener: () => void): unknown;
}
export interface RejectionEvents {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  off(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
}
interface FlushingLog {
  log(level: "error", message: string, data?: unknown): void;
  flushSync(): void;
}

/**
 * Keep buffered log lines when the process dies. An uncaught error is recorded and every
 * buffered line is appended synchronously before Node's default crash handling continues;
 * `exit` covers `process.exit` paths that never return to the event loop.
 * `details` adds fields for errors it recognizes (a full disk names its free space).
 */
export function installFatalLogFlush(
  events: FatalEvents,
  log: FlushingLog,
  details: (error: unknown) => (readonly [string, unknown])[] | undefined = () => undefined,
): () => void {
  const fatal = (error: unknown) => {
    let extra: (readonly [string, unknown])[] | undefined;
    try {
      extra = details(error);
    } catch {
      extra = undefined;
    }
    log.log(
      "error",
      "Fatal error",
      extra ? logFields([["error", logError(error)], ...extra]) : logError(error),
    );
    log.flushSync();
  };
  const exit = () => log.flushSync();
  events.on("uncaughtExceptionMonitor", fatal);
  events.on("exit", exit);
  return () => {
    events.off("uncaughtExceptionMonitor", fatal);
    events.off("exit", exit);
  };
}

/** How many unhandled-rejection lines one minute may write before the rest are only counted. */
const rejectionLinesPerMinute = 20;

/**
 * Last resort for a rejection nobody caught. It is logged and the daemon keeps running: by the
 * time a rejection goes unhandled, the code that made it has already finished, so no state is
 * left half-changed, and ending the daemon would stop every agent for one missed `.catch`.
 * A transient store failure (busy, or a full disk that heals) gets its own line. A storm of
 * rejections writes at most `rejectionLinesPerMinute` lines a minute, then says how many it
 * skipped. Thrown errors stay fatal (`installFatalLogFlush`): one can stop code mid-change.
 */
export function installRejectionGuard(
  events: RejectionEvents,
  log: { log(level: "error", message: string, data?: unknown): void },
  transient: (reason: unknown) => boolean,
  now: () => number,
): () => void {
  let windowStart = Number.NEGATIVE_INFINITY;
  let written = 0;
  let skipped = 0;
  const rejected = (reason: unknown) => {
    const at = now();
    if (at - windowStart >= 60_000) {
      if (skipped > 0)
        log.log("error", "Unhandled rejections not logged", logFields([["count", skipped]]));
      windowStart = at;
      written = 0;
      skipped = 0;
    }
    if (written >= rejectionLinesPerMinute) {
      skipped++;
      return;
    }
    written++;
    log.log(
      "error",
      transient(reason) ? "Unhandled store failure; continuing" : "Unhandled rejection; continuing",
      logError(reason),
    );
  };
  events.on("unhandledRejection", rejected);
  return () => events.off("unhandledRejection", rejected);
}
