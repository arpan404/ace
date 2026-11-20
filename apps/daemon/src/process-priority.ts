import { constants } from "node:os";

/** What raising the daemon's priority needs from the OS. */
export interface PriorityPort {
  platform: NodeJS.Platform;
  /** `os.setPriority` for this process; throws when the OS refuses. */
  setPriority(priority: number): void;
  /**
   * Linux: `/proc/self/limits` and `/proc/self/status`, to tell whether a negative nice is
   * allowed before asking for it. Undefined where they cannot be read.
   */
  limits?: string | undefined;
  status?: string | undefined;
}

/** What happened, for one log line once the daemon's log is open. */
export type PriorityOutcome =
  | { kind: "raised"; priority: number }
  | { kind: "refused"; priority: number; reason: string }
  /** Not asked: the OS would refuse it (Linux without CAP_SYS_NICE or a high RLIMIT_NICE). */
  | { kind: "not-allowed"; priority: number; reason: string }
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
  if (port.platform === "linux") {
    const refused = negativeNiceRefused(port, ABOVE_NORMAL);
    if (refused) return { kind: "not-allowed", priority: ABOVE_NORMAL, reason: refused };
  }
  try {
    port.setPriority(ABOVE_NORMAL);
    return { kind: "raised", priority: ABOVE_NORMAL };
  } catch (error) {
    return { kind: "refused", priority: ABOVE_NORMAL, reason: refusal(error) };
  }
}

/** CAP_SYS_NICE's bit in a capability mask. */
const CAP_SYS_NICE = 23n;

/**
 * Why Linux would refuse this nice, or undefined when it may allow it (or cannot be told). An
 * unprivileged process may lower its nice to `20 - RLIMIT_NICE`; CAP_SYS_NICE (root has it) lifts
 * that.
 */
export function negativeNiceRefused(
  port: Pick<PriorityPort, "limits" | "status">,
  nice: number,
): string | undefined {
  const capabilities = /^CapEff:\s*([0-9a-f]+)$/im.exec(port.status ?? "")?.[1];
  if (capabilities !== undefined && (BigInt(`0x${capabilities}`) >> CAP_SYS_NICE) & 1n)
    return undefined;
  const limit = /^Max nice priority\s+(\S+)/im.exec(port.limits ?? "")?.[1];
  if (limit === undefined || capabilities === undefined) return undefined;
  if (limit === "unlimited") return undefined;
  const soft = Number(limit);
  if (!Number.isFinite(soft) || 20 - soft <= nice) return undefined;
  return `RLIMIT_NICE ${soft} without CAP_SYS_NICE`;
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
  else if (outcome.kind === "refused" || outcome.kind === "not-allowed")
    log.log("info", "The OS kept the daemon at normal priority", {
      priority: outcome.priority,
      reason: outcome.reason,
    });
}
