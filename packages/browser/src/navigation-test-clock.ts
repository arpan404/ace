import type { NavigationClock } from "./navigation.ts";

export class TestNavigationClock implements NavigationClock {
  private time = 0;
  private timers = new Set<{ at: number; work: () => void }>();
  now(): number {
    return this.time;
  }
  set(delay: number, work: () => void): () => void {
    const timer = { at: this.time + delay, work };
    this.timers.add(timer);
    return () => this.timers.delete(timer);
  }
  advance(delay: number): void {
    const end = this.time + delay;
    while (true) {
      const next = [...this.timers]
        .filter((timer) => timer.at <= end)
        .toSorted((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.time = next.at;
      this.timers.delete(next);
      next.work();
    }
    this.time = end;
  }
}
