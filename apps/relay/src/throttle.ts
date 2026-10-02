import type { Clock } from "./clock.ts";
import type { PeerBudget } from "./limits.ts";
type Waiter = { signal: AbortSignal; resolve(): void; reject(error: Error): void; abort(): void };
type Queue = { waiters: Waiter[]; cancel: (() => void) | undefined };
/** One timer per IP bucket; FIFO waiters avoid a per-socket refill stampede. */
export class Throttle {
  #clock: Clock;
  #queues = new Map<string, Queue>();
  #onThrottle: (ip: string) => void;
  constructor(clock: Clock, onThrottle: (ip: string) => void) {
    this.#clock = clock;
    this.#onThrottle = onThrottle;
  }
  wait(peer: PeerBudget, signal: AbortSignal): Promise<void> | undefined {
    if (signal.aborted) return Promise.reject(new Error("Socket closed"));
    const key = peer.key;
    const existing = this.#queues.get(key);
    if (!existing && peer.take(this.#clock.now()) === 0) return undefined;
    const queue = existing ?? { waiters: [], cancel: undefined };
    this.#queues.set(key, queue);
    this.#onThrottle(key);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        abort: () => {
          const i = queue.waiters.indexOf(waiter);
          if (i >= 0) queue.waiters.splice(i, 1);
          reject(new Error("Socket closed"));
          if (queue.waiters.length === 0) {
            queue.cancel?.();
            this.#queues.delete(key);
          }
        },
      };
      queue.waiters.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
      if (!queue.cancel) this.#drain(peer, queue);
    });
  }
  #drain(peer: PeerBudget, queue: Queue): void {
    const key = peer.key;
    queue.cancel = undefined;
    while (queue.waiters.length) {
      const wait = peer.take(this.#clock.now());
      if (wait > 0) {
        queue.cancel = this.#clock.schedule(wait, () => this.#drain(peer, queue));
        return;
      }
      const waiter = queue.waiters.shift();
      if (!waiter) break;
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.resolve();
    }
    this.#queues.delete(key);
  }
  close(): void {
    for (const queue of this.#queues.values()) {
      queue.cancel?.();
      for (const waiter of queue.waiters) {
        waiter.signal.removeEventListener("abort", waiter.abort);
        waiter.reject(new Error("Relay closed"));
      }
    }
    this.#queues.clear();
  }
}
