/**
 * Exit codes of the `ace` CLI (ADR 0072). Whatever starts the daemon (the desktop app, a
 * login service) reads them, so they live here rather than in the daemon.
 * `address-in-use`: `ace start` could not listen because another process holds its port.
 */
export const exitCodes = {
  ok: 0,
  failed: 1,
  "needs-human": 2,
  timeout: 3,
  refused: 4,
  uncertain: 5,
  "address-in-use": 6,
} as const;
