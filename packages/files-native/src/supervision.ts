/** The supervision rules of docs/files/plan.md, "packages/files-native (daemon side)". */
export const supervisionTimings = {
  /** A fresh ace-files must answer `hello` within this long. */
  helloMs: 5_000,
  /** Most requests answer in milliseconds; a hung binary is killed by the request timeout. */
  requestTimeoutMs: 30_000,
  /** A run that stayed up this long resets the restart backoff. */
  healthyResetMs: 60_000,
  restartBaseMs: 250,
  restartMaxMs: 10_000,
} as const;

/** Restart delay after the `attempt`th consecutive failure: 250 ms doubling to 10 s. */
export function restartDelay(attempt: number): number {
  return Math.min(
    supervisionTimings.restartMaxMs,
    supervisionTimings.restartBaseMs * 2 ** Math.max(0, attempt - 1),
  );
}
