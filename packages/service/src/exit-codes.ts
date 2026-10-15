/**
 * Exit codes of the `ace` CLI (ADR 0072). Whatever starts the daemon (the desktop app, a
 * login service) reads them, so they live here rather than in the daemon.
 * `address-in-use`: `ace start` could not listen because another process holds its port.
 * `newer-data`: `ace start` refused ACE_HOME because a newer ace build already wrote its data
 * (the data generation, `apps/daemon/src/data-generation.ts`). 65 is sysexits' EX_DATAERR.
 */
export const exitCodes = {
  ok: 0,
  failed: 1,
  "needs-human": 2,
  timeout: 3,
  refused: 4,
  uncertain: 5,
  "address-in-use": 6,
  "newer-data": 65,
} as const;
