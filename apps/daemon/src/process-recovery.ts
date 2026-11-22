import { setTimeout as delay } from "node:timers/promises";

/** One recovery pass: ends what it can prove is the previous run's, and says how much it ended. */
export interface RecoveryJournal {
  recover(): { killed: number; unresolved?: number };
}
export interface RecoveryClock {
  now(): number;
  wait(milliseconds: number): Promise<void>;
}
const systemClock: RecoveryClock = {
  now: () => performance.now(),
  wait: (milliseconds) => delay(milliseconds),
};

/**
 * Startup, on every platform: recovery ends the previous run's processes, then repeats until
 * they are verifiably gone, so the engine never reads a store a dying process may still write
 * (a Cursor host inside Agent.send, say) and never reports work stopped while it still runs. A
 * pass that ends nothing and finds nothing unproven means every recorded group is gone. Returns
 * false when some tree stays unproven, or ended processes outlive, `limitMs`.
 */
export async function verifyRecovery(
  journal: RecoveryJournal,
  limitMs = 10_000,
  clock: RecoveryClock = systemClock,
): Promise<{ verified: boolean; unresolved: number }> {
  const deadline = clock.now() + limitMs;
  while (true) {
    const result = journal.recover();
    const unresolved = result.unresolved ?? 0;
    if (result.killed === 0 && unresolved === 0) return { verified: true, unresolved: 0 };
    // A group that can't be identified may still end on its own: it is looked at again until
    // the bound, like one that was just ended.
    if (clock.now() >= deadline) return { verified: false, unresolved: unresolved + result.killed };
    await clock.wait(100);
  }
}
