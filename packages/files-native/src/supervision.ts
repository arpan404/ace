/** The supervision rules of docs/files/plan.md, "packages/files-native (daemon side)". */
export const supervisionTimings = {
  /** A fresh ace-files must answer `hello` within this long. */
  helloMs: 10_000,
  /** Most requests answer in milliseconds; a hung binary is killed by the request timeout. */
  requestTimeoutMs: 30_000,
  /** A run that stayed up this long resets the restart backoff. */
  healthyResetMs: 60_000,
  restartBaseMs: 250,
  restartMaxMs: 10_000,
  /** How long a watch whose re-open failed retryably waits before its next attempt. */
  restoreRetryMs: 500,
  /** Attempts one watch gets before a retryable re-open failure becomes a warning. */
  restoreRetries: 5,
  /** Frames held for a child that is not reading stdin; past this, body writes get `BUSY`. */
  stdinQueueLimit: 64 * 1024 * 1024,
} as const;

/** Restart delay after the `attempt`th consecutive failure: 250 ms doubling to 10 s. */
export function restartDelay(attempt: number): number {
  return Math.min(
    supervisionTimings.restartMaxMs,
    supervisionTimings.restartBaseMs * 2 ** Math.max(0, attempt - 1),
  );
}
