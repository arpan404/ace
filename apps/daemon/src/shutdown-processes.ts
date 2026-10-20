import { logError, logFields, type ComponentLogger } from "@ace/diagnostics";

/**
 * How long a daemon shutdown lets services stop their child processes politely. Providers
 * interrupt turns, unsubscribe threads and wait out SIGTERM grace periods of their own; with
 * several busy threads that alone outlasts the overall shutdown deadline.
 */
export const POLITE_SHUTDOWN_MS = 3_000;
/** SIGTERM to SIGKILL for the forced stop. */
export const FORCED_GRACE_MS = 500;

/**
 * Once the polite window has passed, stop every child process group the daemon still owns.
 * Their exits release the services waiting on them, so shutdown completes before its deadline.
 * Each thread's interrupted work was recorded before its session began closing.
 */
export function forceStopAfterPoliteWindow(options: {
  schedule: (name: string, expire: () => void, milliseconds: number) => () => void;
  stop: (graceMs: number) => Promise<void>;
  log: ComponentLogger;
  pending: () => string[];
  politeMs?: number;
}): () => void {
  return options.schedule(
    "shutdown:processes",
    () => {
      options.log.log(
        "warn",
        "Daemon shutdown is stopping child processes that did not exit",
        logFields([
          ["afterMs", options.politeMs ?? POLITE_SHUTDOWN_MS],
          ["pending", options.pending().slice(0, 24)],
        ]),
      );
      void options
        .stop(FORCED_GRACE_MS)
        .catch((error: unknown) =>
          options.log.log("warn", "Child processes could not all be stopped", logError(error)),
        );
    },
    options.politeMs ?? POLITE_SHUTDOWN_MS,
  );
}
