/** What to do about a renderer that just crashed. */
export type CrashDecision =
  | { kind: "reload"; delayMs: number }
  | { kind: "give-up"; crashes: number };

export interface CrashPolicy {
  /** Crashes older than this no longer count. */
  windowMs: number;
  /** The wait before each automatic reload: the first crash's, the second's, and so on. */
  delaysMs: readonly number[];
}

export const defaultCrashPolicy: CrashPolicy = { windowMs: 60_000, delaysMs: [0, 2_000] };

/**
 * When a view's renderer crashes, ace reloads it, waiting longer after each crash, and stops
 * once it has crashed more times within `windowMs` than there are delays: a page that kills
 * its renderer on load must not reload forever. The view then shows its crashed state until
 * someone reloads it by hand.
 */
export class CrashBackoff {
  private crashes: number[] = [];
  private policy: CrashPolicy;

  constructor(policy: CrashPolicy = defaultCrashPolicy) {
    this.policy = policy;
  }

  crashed(now: number): CrashDecision {
    this.crashes = [...this.crashes.filter((at) => now - at < this.policy.windowMs), now];
    const delayMs = this.policy.delaysMs[this.crashes.length - 1];
    return delayMs === undefined
      ? { kind: "give-up", crashes: this.crashes.length }
      : { kind: "reload", delayMs };
  }
}
