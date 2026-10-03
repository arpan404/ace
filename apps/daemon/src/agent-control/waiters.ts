import type { ThreadId, DelegationOutcome } from "@ace/protocol";

/** Wait cancellation detaches observers; it never cancels accepted provider work. */
export class OutcomeWaiters {
  private lifetime = new AbortController();
  private waits = new Map<ThreadId, Set<(result: DelegationOutcome) => void>>();
  private count = 0;
  has(thread: ThreadId) {
    return this.waits.has(thread);
  }
  deliver(thread: ThreadId, result: DelegationOutcome) {
    for (const receive of this.waits.get(thread) ?? []) receive(result);
  }
  async wait(thread: ThreadId, callerSignal: AbortSignal): Promise<DelegationOutcome> {
    const signal = AbortSignal.any([callerSignal, this.lifetime.signal]);
    signal.throwIfAborted();
    if (this.count >= 64) throw new Error("Wait capacity");
    this.count++;
    try {
      return await new Promise<DelegationOutcome>((resolve, reject) => {
        const observers = this.waits.get(thread) ?? new Set<(result: DelegationOutcome) => void>();
        const finish = (result: DelegationOutcome) => {
          cleanup();
          resolve(result);
        };
        const abort = () => {
          cleanup();
          reject(new Error("Wait cancelled"));
        };
        const cleanup = () => {
          signal.removeEventListener("abort", abort);
          observers.delete(finish);
          if (!observers.size) this.waits.delete(thread);
        };
        observers.add(finish);
        this.waits.set(thread, observers);
        signal.addEventListener("abort", abort, { once: true });
      });
    } finally {
      this.count--;
    }
  }
  close() {
    this.lifetime.abort();
  }
}
