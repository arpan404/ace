import type { Command, ThreadId } from "@ace/protocol";
import type { EngineClock } from "./actor.ts";

/*
 * Threads whose last run may still have work running: startup could not prove its processes
 * gone. Nothing runs for such a thread here (no session opens, no queued send, recovery or
 * transition) until a later check proves them gone or the person chooses to continue anyway.
 * The check repeats in the background, bounded and backing off.
 */

/** Waits between background checks, doubling to about five minutes, then it stops. */
export const recheckMs: readonly number[] = [
  5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000,
];

export class Survivors {
  private held = new Set<ThreadId>();
  private cancel: (() => void) | undefined;
  private attempt = 0;
  private checking = false;
  private clock: EngineClock;
  private recheck: (() => Promise<boolean>) | undefined;
  private released: (ids: ThreadId[]) => void;
  /** `released` hears the threads let go, once a check proves the last run's processes gone. */
  constructor(
    clock: EngineClock,
    recheck: (() => Promise<boolean>) | undefined,
    released: (ids: ThreadId[]) => void,
  ) {
    this.clock = clock;
    this.recheck = recheck;
    this.released = released;
  }
  has(id: ThreadId): boolean {
    return this.held.has(id);
  }
  /** Startup could not prove `id`'s last run stopped. */
  hold(id: ThreadId): void {
    this.held.add(id);
    this.schedule();
  }
  /**
   * The person's own Resume of a held thread: they choose to continue anyway, so it is let go
   * before the command runs. Nothing automatic lets a thread go.
   */
  admitted(command: Command): void {
    const payload = command.payload;
    if (payload.type !== "thread.resume" && payload.type !== "queue.resume") return;
    if (this.held.delete(payload.threadId)) this.released([payload.threadId]);
  }
  close(): void {
    this.cancel?.();
    this.cancel = undefined;
    this.recheck = undefined;
  }
  private schedule(): void {
    if (this.cancel || this.checking || !this.recheck || !this.held.size) return;
    const wait = recheckMs[this.attempt++];
    if (wait === undefined) return;
    this.cancel = this.clock.setTimer(() => {
      this.cancel = undefined;
      void this.check();
    }, wait);
  }
  private async check(): Promise<void> {
    const recheck = this.recheck;
    if (!recheck || !this.held.size) return;
    this.checking = true;
    let verified = false;
    try {
      verified = await recheck();
    } catch {
      verified = false;
    } finally {
      this.checking = false;
    }
    if (!verified) {
      this.schedule();
      return;
    }
    const ids = [...this.held];
    this.held.clear();
    this.released(ids);
  }
}
