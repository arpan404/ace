import type { MachineCodeRefusal } from "@ace/protocol";

/** "1 minute", "14 minutes": how long code entry stays paused, rounded up. */
function minutesLeft(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/**
 * The one sentence a machine code prompt shows for why the machine asked, and whether the
 * field takes a code now. A lock with a known end counts down to it; past it, entry opens again.
 */
export function machineCodePrompt(
  reason: MachineCodeRefusal,
  machine: string,
  lockedUntil: number | undefined,
  now: number,
): { sentence: string; open: boolean } {
  if (reason === "machine_code_locked") {
    if (lockedUntil !== undefined && lockedUntil <= now)
      return { sentence: `Enter ${machine}'s machine code to open it.`, open: true };
    return {
      sentence:
        lockedUntil === undefined
          ? "Too many wrong codes. Try again in a few minutes."
          : `Too many wrong codes. Try again in ${minutesLeft(lockedUntil - now)}.`,
      open: false,
    };
  }
  if (reason === "machine_code_wrong")
    return { sentence: "That code didn't match. Try again.", open: true };
  return { sentence: `Enter ${machine}'s machine code to open it.`, open: true };
}
