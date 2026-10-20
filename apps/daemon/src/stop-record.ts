import { logError, logFields, type ComponentLogger } from "@ace/diagnostics";
import type { DaemonRun } from "./run-marker.ts";
import type { StopReason } from "./stop-reason.ts";

export interface Stopping {
  reason: StopReason;
  at: number;
}

/** Most names a deadline record carries; the rest are counted. */
const NAMED = 24;

/**
 * Records how this run ended, once: in the run marker the next start reads, and as the
 * daemon log's closing line. A shutdown that overran its deadline still records a stop,
 * with the resources it was waiting on, so the next start doesn't report a crash.
 */
export function stopRecorder(options: {
  run: () => DaemonRun | undefined;
  log: ComponentLogger;
  now: () => number;
  pid: number;
}) {
  let recorded = false;
  const record = (stopping: Stopping, pending?: readonly string[]) => {
    if (recorded) return;
    recorded = true;
    try {
      options.run()?.stopped(stopping.reason, pending);
    } catch (error) {
      options.log.log("warn", "Daemon run marker could not be written", logError(error));
    }
    const durationMs = Math.max(0, Math.round(options.now() - stopping.at));
    if (!pending) {
      options.log.log(
        "info",
        "Daemon stopped",
        logFields([
          ["source", stopping.reason.source],
          ["durationMs", durationMs],
          ["pid", options.pid],
        ]),
      );
      return;
    }
    options.log.log(
      "error",
      "Daemon shutdown deadline exceeded",
      logFields([
        ["source", stopping.reason.source],
        ["durationMs", durationMs],
        ["pid", options.pid],
        ["pending", pending.slice(0, NAMED)],
        ...(pending.length > NAMED ? [["morePending", pending.length - NAMED] as const] : []),
      ]),
    );
  };
  return {
    /** Every resource closed. */
    stopped: (stopping: Stopping) => record(stopping),
    /** The deadline hit first; `pending` names what had not finished closing. */
    overran: (stopping: Stopping, pending: readonly string[]) => record(stopping, pending),
  };
}
