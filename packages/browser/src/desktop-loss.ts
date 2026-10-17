import type { NavigationClock } from "./navigation.ts";

/**
 * How long a thread waits for the desktop to come back and hand its views over again (ADR 0085)
 * before reporting their pages lost. A link blip reconnects within the desktop's first retries
 * (1 s, then 2 s, then 4 s).
 */
export const desktopReadoptionGraceMs = 10_000;

/**
 * One thread's loss of its desktop link. The desktop keeps the views alive and re-adopts them on
 * reconnect, so the loss is reported (`report`) only when the grace passes without that. Agent
 * work that wants the page meanwhile waits for the grace (`settled`) instead of moving the page
 * to ace's Chrome while the desktop is still on its way back.
 */
export class DesktopLoss {
  private cancel: (() => void) | undefined;
  private waiting: PromiseWithResolvers<void> | undefined;
  private clock: NavigationClock;
  private graceMs: number;
  /** The loss went out to the thread's viewers. */
  reported = false;
  constructor(clock: NavigationClock, graceMs = desktopReadoptionGraceMs) {
    this.clock = clock;
    this.graceMs = graceMs;
  }
  /** Whether the grace is running: the desktop may still hand the views back. */
  get pending(): boolean {
    return this.waiting !== undefined;
  }
  begin(report: () => void): void {
    this.finish();
    this.reported = false;
    const waiting = Promise.withResolvers<void>();
    this.waiting = waiting;
    const expire = () => {
      if (this.waiting !== waiting) return;
      this.waiting = undefined;
      this.cancel = undefined;
      this.reported = true;
      report();
      waiting.resolve();
    };
    if (this.graceMs <= 0) {
      expire();
      return;
    }
    this.cancel = this.clock.set(this.graceMs, expire);
  }
  /** Resolves when the grace ends, by expiry or by the backend coming back. */
  settled(): Promise<void> {
    return this.waiting?.promise ?? Promise.resolve();
  }
  /** The thread has a backend again (re-adopted, reopened or moved): stop waiting. */
  finish(): void {
    this.cancel?.();
    this.cancel = undefined;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.resolve();
  }
}
