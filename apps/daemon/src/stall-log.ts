import { logError, logFields, type ComponentLogger } from "@ace/diagnostics";
import { systemLoopClock } from "./loop-monitor.ts";
import { stallFields } from "./stall-report.ts";
import {
  startStallWatchdog,
  takePreviousStallReports,
  type StallWatchdogTiming,
} from "./stall-watchdog.ts";

/**
 * Logs where the previous run froze if it was killed frozen, then watches this run. A watchdog
 * that cannot start costs a warning, never the daemon.
 */
export function watchStalls(
  log: Pick<ComponentLogger, "log">,
  directory: string,
  timing?: Partial<StallWatchdogTiming>,
): () => Promise<void> {
  for (const report of takePreviousStallReports(directory, process.pid))
    log.log(
      "warn",
      "Previous daemon run froze",
      logFields([
        ["previousPid", report.pid],
        ["frozenSince", new Date(report.silentSince).toISOString()],
        ...stallFields(report),
      ]),
    );
  try {
    return startStallWatchdog({
      directory,
      pid: process.pid,
      // Always real time: the watchdog thread measures silence on its own monotonic clock.
      clock: systemLoopClock,
      ...(timing ? { timing } : {}),
      onStall: (report) =>
        log.log("warn", "Event loop stall cause", logFields(stallFields(report))),
      onError: (error) => log.log("warn", "Stall watchdog failed", logError(error)),
    });
  } catch (error) {
    log.log("warn", "Stall watchdog unavailable", logError(error));
    return async () => {};
  }
}
