import type { Clock } from "../index.ts";
/** Explicit timer execution; socket events, rather than sleeps, synchronize real network tests. */
export class ManualClock implements Clock {
  #now = 0;
  #next = 0;
  #timers = new Map<number, { at: number; callback: () => void }>();
  now(): number {
    return this.#now;
  }
  schedule(delayMs: number, callback: () => void): () => void {
    const id = ++this.#next;
    this.#timers.set(id, { at: this.#now + delayMs, callback });
    return () => {
      this.#timers.delete(id);
    };
  }
  advance(milliseconds: number): void {
    this.#now += milliseconds;
    for (const [id, timer] of this.#timers)
      if (timer.at <= this.#now) {
        this.#timers.delete(id);
        timer.callback();
      }
  }
}
