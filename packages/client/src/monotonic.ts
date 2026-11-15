/**
 * The monotonic clock for liveness and connect durations when the app passes none
 * (`ClientOptions.monotonic`, `MultipathOptions.monotonic`): read only where a connection or a
 * path manager is composed, the one place the client reaches for a clock itself (ADR 0150). A
 * runtime without `performance` falls back to the wall clock; the heartbeat keeps time it reads
 * from going backwards, and a negative round-trip sample is refused (`rttSample`).
 */
export const defaultMonotonic: () => number =
  typeof performance === "undefined" ? () => Date.now() : () => performance.now();
