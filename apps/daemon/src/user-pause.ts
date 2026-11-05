import { existsSync, rmSync, writeFileSync } from "node:fs";
import type { MaintenanceGate } from "@ace/service";

/**
 * Keeps the person's pause (the `user` hold, ADR 0041) across daemon restarts as a marker file:
 * present while paused, absent otherwise. Restores the hold now, so call it before any service
 * starts and startup recovery honours it, then follows every later pause and resume, whichever
 * client or route made it. Returns the unsubscribe.
 */
export function keepUserPause(
  gate: MaintenanceGate,
  file: string,
  onError: (error: unknown) => void,
): () => void {
  if (existsSync(file)) gate.enter("user");
  let saved = gate.held("user");
  return gate.onChange(() => {
    const paused = gate.held("user");
    if (paused === saved) return;
    try {
      if (paused) writeFileSync(file, "paused\n", { mode: 0o600 });
      else rmSync(file, { force: true });
      saved = paused;
    } catch (error) {
      onError(error);
    }
  });
}
