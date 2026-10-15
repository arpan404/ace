import { logError, logFields } from "@ace/diagnostics";

export interface FatalEvents {
  on(event: "uncaughtExceptionMonitor", listener: (error: unknown) => void): unknown;
  on(event: "exit", listener: () => void): unknown;
  off(event: "uncaughtExceptionMonitor", listener: (error: unknown) => void): unknown;
  off(event: "exit", listener: () => void): unknown;
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
