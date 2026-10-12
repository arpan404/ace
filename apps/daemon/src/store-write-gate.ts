/** Store admission: asynchronous writers enter here, and maintenance holds them all. */
export interface StoreWriteGateOptions {
  /** Bounded waits. Injected so tests control time; defaults to AbortSignal.timeout. */
  timeout?: (ms: number) => AbortSignal;
  /** How long a held writer waits for maintenance before failing as busy. */
  holdMs?: number;
  /** How long maintenance waits for in-flight writers before giving up. */
  drainMs?: number;
}

const busy = () => new Error("Store is busy");

export class StoreWriteGate {
  private writers = 0;
  private held = false;
  private readonly opened = new Set<() => void>();
  private readonly drained = new Set<() => void>();
  private readonly timeout: (ms: number) => AbortSignal;
  private readonly holdMs: number;
  private readonly drainMs: number;
  constructor(options: StoreWriteGateOptions = {}) {
    this.timeout = options.timeout ?? AbortSignal.timeout;
    this.holdMs = options.holdMs ?? 60_000;
    this.drainMs = options.drainMs ?? 10_000;
  }
  /** True from the moment maintenance is requested until its work settles. */
  isHeld(): boolean {
    return this.held;
  }
  /** Resolve once no maintenance holds writes; reject as busy after the bounded hold. */
  async open(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.held) return;
    const limit = this.timeout(this.holdMs);
    await wait(this.opened, signal, limit);
  }
  /**
   * Register a writer whose commits span awaits, such as a worker on another connection.
   * Maintenance drains every registered writer before it starts and none can enter while held.
   */
  enter(): () => void {
    if (this.held) throw busy();
    this.writers++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.writers === 0) settle(this.drained);
    };
  }
  /** Hold new writers, drain in-flight ones within the bound, then run work exclusively. */
  async exclusive<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.held) throw busy();
    this.held = true;
    try {
      if (this.writers > 0) await wait(this.drained, signal, this.timeout(this.drainMs));
      signal?.throwIfAborted();
      return await work();
    } finally {
      this.held = false;
      settle(this.opened);
    }
  }
}

function settle(waiters: Set<() => void>): void {
  const ready = [...waiters];
  waiters.clear();
  for (const resolve of ready) resolve();
}

function wait(waiters: Set<() => void>, signal: AbortSignal | undefined, limit: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      waiters.delete(ready);
      signal?.removeEventListener("abort", aborted);
      limit.removeEventListener("abort", expired);
      if (error === undefined) resolve();
      else reject(error);
    };
    const ready = () => finish();
    const aborted = () => finish(signal?.reason);
    const expired = () => finish(busy());
    if (signal?.aborted) return aborted();
    if (limit.aborted) return expired();
    waiters.add(ready);
    signal?.addEventListener("abort", aborted, { once: true });
    limit.addEventListener("abort", expired, { once: true });
  });
}
