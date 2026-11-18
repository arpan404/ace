import type { WatchClock } from "./watch-fanout.ts";

/** A clock whose timers run only when a test advances it, in `at` order. */
export class TestClock implements WatchClock {
  #now = 0;
  #timers: { at: number; run: () => void }[] = [];

  setTimeout(callback: () => void, ms: number): () => void {
    const timer = { at: this.#now + ms, run: callback };
    this.#timers.push(timer);
    return () => {
      this.#timers = this.#timers.filter((candidate) => candidate !== timer);
    };
  }

  advance(ms: number): void {
    const end = this.#now + ms;
    for (;;) {
      const next = this.#timers
        .filter((timer) => timer.at <= end)
        .toSorted((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.#timers = this.#timers.filter((timer) => timer !== next);
      this.#now = next.at;
      next.run();
    }
    this.#now = end;
  }
}
