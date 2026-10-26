/**
 * When the notification worker should next run delivery, from the deadline it reported. Work
 * that was already due when the previous run began and is still due is held up (a full queue),
 * so it is retried once a second rather than in a tight loop. No deadline means no timer.
 */
export function wakeDelay(
  deadline: number | null,
  now: number,
  lastRunStartedAt: number | undefined,
): number | undefined {
  if (deadline === null) return undefined;
  if (deadline > now) return deadline - now;
  return lastRunStartedAt !== undefined && deadline <= lastRunStartedAt ? 1000 : 0;
}

/** Facts the daemon checks before stopping an idle notification worker. */
export interface SleepFacts {
  /** The worker's own report: no queued work, no presence, no device that needs it offline. */
  idle: boolean;
  /** Sockets that could take a live alert. */
  connected: number;
  /** Delivery runs or client calls still in progress. */
  busy: boolean;
}
export function maySleep(facts: SleepFacts): boolean {
  return facts.idle && facts.connected === 0 && !facts.busy;
}

/** Retry delay after a failed delivery run: doubling from a second, capped at thirty. */
export function failureDelay(failures: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, Math.min(failures - 1, 5)));
}
