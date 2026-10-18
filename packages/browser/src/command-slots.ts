/**
 * Bounds unsettled commands on one transport without dropping the excess.
 *
 * A command over the limit waits for a slot instead of failing: some commands (a paused
 * request's continue or fail decision) have no retry, and dropping one leaves the page waiting
 * forever. Waiters are served in order; the backlog itself is bounded.
 */
export class CommandSlots {
  private readonly limit: number;
  private readonly backlog: number;
  private used = 0;
  private waiters: { grant(): void; fail(error: unknown): void }[] = [];
  constructor(limit: number, backlog: number) {
    this.limit = limit;
    this.backlog = backlog;
  }
  /** Runs `work` once a slot is free; the slot is held until its promise settles. */
  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.used < this.limit && this.waiters.length === 0) {
      this.used++;
      return this.hold(work);
    }
    if (this.waiters.length >= this.backlog)
      return Promise.reject(new Error("Browser command backlog limit"));
    return new Promise<void>((grant, fail) => {
      const waiter = {
        grant: () => {
          signal?.removeEventListener("abort", abort);
          grant();
        },
        fail,
      };
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        fail(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.waiters.push(waiter);
    }).then(() => this.hold(work));
  }
  private hold<T>(work: () => Promise<T>): Promise<T> {
    let result: Promise<T>;
    try {
      result = work();
    } catch (error) {
      result = Promise.reject(error);
    }
    return result.finally(() => this.release());
  }
  private release(): void {
    // The slot passes straight to the next waiter, so new callers cannot overtake it.
    const next = this.waiters.shift();
    if (next) next.grant();
    else this.used--;
  }
}
