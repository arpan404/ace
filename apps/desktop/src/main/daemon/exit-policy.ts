import { exitCodes } from "@ace/service/exit-codes";
import type { DaemonStatus } from "../../shared/contract.ts";

/** Exponential restart delay: 0.5 s, 1 s, 2 s … capped at 30 s. */
export function restartDelay(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** Math.max(0, attempt));
}

/**
 * `ace start` refuses data written by a newer ace build with this exit code. Restarting
 * cannot help, so the supervisor stops and says what to do instead.
 */
const NEWER_DATA_EXIT = exitCodes["newer-data"];
export const newerDataMessage =
  "A newer version of ace already uses this data. Open the newest ace, or update this one.";

/**
 * `ace start` stops on a store under ACE_HOME in a format this build does not read. The
 * daemon's own log names the file and the recovery; restarting would stop the same way.
 */
const INCOMPATIBLE_DATA_EXIT = exitCodes["incompatible-data"];
export const incompatibleDataMessage =
  "ace can't read some of its saved data because a different ace build wrote it. The daemon log names the file and how to set it aside.";

/** What a daemon's exit code says about why it stopped, when it says anything. */
function exitCause(code: number | null): DaemonStatus["cause"] {
  return code === exitCodes["address-in-use"] ? "port-in-use" : undefined;
}

export interface UnexpectedExit {
  code: number | null;
  signal: string | null;
  /** Restarts in a row so far, after any reset for a stable run. */
  crashes: number;
  maxRestarts: number;
}

/** What to do after the daemon this app started exited without being asked to. */
export type ExitDecision =
  | { kind: "newer-data" }
  | { kind: "incompatible-data" }
  | { kind: "give-up"; reason: string; cause: DaemonStatus["cause"] }
  | { kind: "restart"; reason: string; cause: DaemonStatus["cause"]; delayMs: number };

/**
 * Restart with backoff until `maxRestarts` in a row, except for an exit that says a restart
 * would be refused the same way (data from a newer build, or in a format it cannot read).
 */
export function exitDecision(exit: UnexpectedExit): ExitDecision {
  if (exit.code === NEWER_DATA_EXIT) return { kind: "newer-data" };
  if (exit.code === INCOMPATIBLE_DATA_EXIT) return { kind: "incompatible-data" };
  const reason = `The daemon exited (${exit.signal ?? `code ${exit.code}`})`;
  const cause = exitCause(exit.code);
  if (exit.crashes >= exit.maxRestarts) return { kind: "give-up", reason, cause };
  return { kind: "restart", reason, cause, delayMs: restartDelay(exit.crashes) };
}
