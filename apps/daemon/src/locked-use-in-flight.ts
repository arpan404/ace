/*
 * Computer requests sent to app helpers outside any protected interval, counted from the
 * moment each is sent until it settles. A helper request settles only once the helper replied
 * or was killed, so a count of zero means none of them can still touch the desktop.
 */
import type { Scheduler } from "@ace/screen";

export class UnprotectedSends {
  #count = 0;
  readonly #waiters = new Set<() => void>();

  get count(): number {
    return this.#count;
  }

  /** Runs `send`, counted from this call (synchronously) until it settles either way. */
  track<T>(send: () => Promise<T>): Promise<T> {
    this.#count++;
    let sent: Promise<T>;
    try {
      sent = send();
    } catch (error) {
      sent = Promise.reject(error);
    }
    return sent.finally(() => {
      this.#count--;
      if (this.#count === 0) for (const wake of this.#waiters) wake();
    });
  }

  /**
   * Resolves true once nothing is in flight, false if that takes longer than `timeoutMs` or
   * `signal` aborts first.
   */
  drained(timeoutMs: number, scheduler: Scheduler, signal?: AbortSignal): Promise<boolean> {
    if (this.#count === 0) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let stopTimer: (() => void) | undefined;
      const done = (drained: boolean) => {
        this.#waiters.delete(wake);
        stopTimer?.();
        signal?.removeEventListener("abort", onAbort);
        resolve(drained);
      };
      const wake = () => done(true);
      const onAbort = () => done(false);
      this.#waiters.add(wake);
      stopTimer = scheduler.after(timeoutMs, () => done(false));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
