import { setTimeout as delay } from "node:timers/promises";

/** One pass over the process record: what it ended, and what it could not prove the run's. */
export interface ProcessRecord {
  recover(): { killed: number; unresolved?: number };
}

/**
 * Cursor only (ADR 0043, amendment of 2026-11-22): whether the previous run's process groups
 * are gone, asked only before a Cursor send in doubt would be sent again as never admitted. A
 * group SIGKILLed at startup can still be running, mid-write, a moment later. Bounded and
 * asynchronous, so it never holds the socket or any other provider: false once the bound is
 * reached with something still alive or unproven.
 */
export async function previousGroupsGone(
  record: ProcessRecord,
  limitMs = 2_000,
  clock: { now(): number; wait(ms: number): Promise<void> } = {
    now: () => performance.now(),
    wait: (ms) => delay(ms),
  },
): Promise<boolean> {
  const deadline = clock.now() + limitMs;
  for (;;) {
    let result: { killed: number; unresolved?: number };
    try {
      result = record.recover();
    } catch {
      return false;
    }
    if (result.killed === 0 && (result.unresolved ?? 0) === 0) return true;
    if (clock.now() >= deadline) return false;
    await clock.wait(100);
  }
}
