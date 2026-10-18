import type { OrganizerSchedule } from "./thread-organizer.ts";

/**
 * Virtual time for timer chains that re-arm themselves once their work settles (the workspace
 * refresh sweep and head watch). Firing a timer waits for its chain to re-arm, so after
 * `advance` every piece of work that came due has finished. Test and bench support only.
 */
export class VirtualSchedule {
  at: number;
  private timers = new Set<{ due: number; work: () => void }>();
  private armed = 0;
  private waiters: (() => void)[] = [];
  constructor(at = 1_000_000) {
    this.at = at;
  }
  readonly now = () => this.at;
  readonly schedule: OrganizerSchedule = (delay, work) => {
    const timer = { due: this.at + delay, work };
    this.timers.add(timer);
    this.armed++;
    for (const wake of this.waiters.splice(0)) wake();
    return () => void this.timers.delete(timer);
  };
  /** Resolves once `count` timers have been armed in total. */
  async armedAtLeast(count: number): Promise<void> {
    while (this.armed < count) await new Promise<void>((wake) => this.waiters.push(wake));
  }
  async advance(ms: number): Promise<void> {
    const end = this.at + ms;
    for (;;) {
      let next: { due: number; work: () => void } | undefined;
      for (const timer of this.timers)
        if (timer.due <= end && (!next || timer.due < next.due)) next = timer;
      if (!next) break;
      this.timers.delete(next);
      this.at = next.due;
      const before = this.armed;
      next.work();
      await this.armedAtLeast(before + 1);
    }
    this.at = end;
  }
}
