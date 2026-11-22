import { setTimeout as delay } from "node:timers/promises";

export interface WindowsRecoveryJournal {
  recoverWindows(): { removed: number; killed: number; unresolved: number };
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
 * Windows startup: recovery ends the previous run's proven processes, then repeats until they
 * are verifiably gone, so the engine never reports work stopped while it still runs. Returns
 * false when some tree stays unproven (a process that may be the run's cannot be told apart
 * from a stranger's) or ended members outlive `limitMs`.
 */
export async function verifyWindowsRecovery(
  journal: WindowsRecoveryJournal,
  limitMs = 10_000,
  clock: RecoveryClock = systemClock,
): Promise<{ verified: boolean; unresolved: number }> {
  const deadline = clock.now() + limitMs;
  while (true) {
    const result = journal.recoverWindows();
    if (result.killed === 0)
      return { verified: result.unresolved === 0, unresolved: result.unresolved };
    if (clock.now() >= deadline) return { verified: false, unresolved: result.unresolved };
    await clock.wait(100);
  }
}
