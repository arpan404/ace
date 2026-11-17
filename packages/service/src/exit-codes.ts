import { cliExitCodes } from "@ace/protocol/cli-output";

/**
 * Exit codes of the `ace` CLI (ADR 0072). Whatever starts the daemon (the desktop app, a
 * login service) reads them, so they live here rather than in the daemon.
 * `address-in-use`: `ace start` could not listen because another process holds its port.
 * `newer-data`: `ace start` refused ACE_HOME because a newer ace build already wrote its data
 * (its `ace-format.json`, `HOME_FORMAT_VERSION` in `home-format.ts`). 65 is sysexits' EX_DATAERR.
 * `incompatible-data`: a store under ACE_HOME is in a format this build does not read
 * (`@ace/provider-kit/incompatible-data`); its message names the file and the recovery.
 * `lock-held`: `ace start` could not take ACE_HOME's daemon lock because another daemon holds
 * it, usually one still starting up or shutting down.
 * `usage`: the command line was wrong (ADR 0176): an unknown command or flag, or a missing or bad
 * argument. 64 is sysexits' EX_USAGE.
 */
export const exitCodes = cliExitCodes;
