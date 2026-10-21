import type { NavigationClock } from "./navigation.ts";

/** The first wait before a thread's paused browser tries to come back on its own. */
export const recoveryRetryFirstMs = 1_000;
/** The longest wait between two of those tries. */
export const recoveryRetryMaxMs = 60_000;

/**
 * When one thread's paused browser next tries to recover by itself, so a page lost while the
 * desktop stayed connected (a view that stopped answering, a capture that timed out) comes back
 * without anyone pressing Reopen. One try is armed at a time. Each failed try waits twice as long
 * as the last, up to a minute. A recovery that holds for a minute starts the waits over; one that
 * is lost again sooner keeps waiting longer, so a page that keeps failing is not reopened in a loop.
 */
export class RecoveryRetry {
  private clock: NavigationClock;
  private cancel: (() => void) | undefined;
  private tries = 0;
  private recoveredAt: number | undefined;
  constructor(clock: NavigationClock) {
    this.clock = clock;
  }
  /** Arm the next try, unless one is armed already. */
  schedule(work: () => void): void {
    if (this.cancel) return;
    const now = this.clock.now();
    if (this.recoveredAt !== undefined && now - this.recoveredAt >= recoveryRetryMaxMs)
      this.tries = 0;
    this.recoveredAt = undefined;
    const delay = Math.min(recoveryRetryMaxMs, recoveryRetryFirstMs * 2 ** this.tries);
    this.tries++;
    this.cancel = this.clock.set(delay, () => {
      this.cancel = undefined;
      work();
    });
  }
  /** The browser is back (on its own or by Reopen): no try is due. */
  recovered(): void {
    this.stop();
    this.recoveredAt = this.clock.now();
  }
  /** The browser closed: nothing more to try. */
  stop(): void {
    this.cancel?.();
    this.cancel = undefined;
  }
}
