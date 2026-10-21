import { constants } from "node:os";

/** What raising the daemon's priority needs from the OS. */
export interface PriorityPort {
  platform: NodeJS.Platform;
  /** `os.setPriority` for this process; throws when the OS refuses. */
  setPriority(priority: number): void;
}

/** What happened, for one log line once the daemon's log is open. */
export type PriorityOutcome =
  | { kind: "raised"; priority: number }
  | { kind: "refused"; priority: number; reason: string }
  | { kind: "unchanged" };

/** Windows: the ABOVE_NORMAL priority class. Linux: nice -7. */
const ABOVE_NORMAL = constants.priority.PRIORITY_ABOVE_NORMAL;

/**
 * Asks the OS to schedule this daemon ahead of ordinary work, so a loaded machine does not
 * starve the event loop that answers clients and health checks. Never throws: a refusal
 * leaves the daemon at its normal priority.
 *
 * - Windows: ABOVE_NORMAL needs no privilege, and the CLIs the daemon starts do not inherit
 *   it (Windows only passes IDLE and BELOW_NORMAL on to child processes).
 * - Linux: a negative nice needs CAP_SYS_NICE or an RLIMIT_NICE above 20, so most systems
 *   refuse it (EACCES). Where it is allowed, the CLIs the daemon starts inherit it.
 * - macOS: a process cannot raise itself without privilege. The desktop launches its daemon
 *   through `taskpolicy -a` instead.
 */
export function raiseDaemonPriority(port: PriorityPort): PriorityOutcome {
  if (port.platform !== "win32" && port.platform !== "linux") return { kind: "unchanged" };
  try {
    port.setPriority(ABOVE_NORMAL);
    return { kind: "raised", priority: ABOVE_NORMAL };
  } catch (error) {
    return { kind: "refused", priority: ABOVE_NORMAL, reason: refusal(error) };
  }
}

/** The OS error code (`EACCES`) of Node's `uv_os_setpriority` failure, else its message. */
function refusal(error: unknown): string {
  const info: unknown = error instanceof Error ? Reflect.get(error, "info") : undefined;
  const code: unknown = typeof info === "object" && info ? Reflect.get(info, "code") : undefined;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.message : String(error);
}

/** Records the outcome once, at info: a refusal is the normal case on Linux, not an error. */
export function logPriority(
  outcome: PriorityOutcome,
  log: { log(level: "info", message: string, data?: unknown): void },
): void {
  if (outcome.kind === "raised")
    log.log("info", "The daemon runs above normal priority", { priority: outcome.priority });
  else if (outcome.kind === "refused")
    log.log("info", "The OS kept the daemon at normal priority", {
      priority: outcome.priority,
      reason: outcome.reason,
    });
}
