import type { ThreadId } from "@ace/protocol";

/** Coalesce wakeups while preserving another pass after work accepted during I/O. */
export class IntentWorkers {
  private tasks = new Map<ThreadId, Promise<void>>();
  private rerun = new Set<ThreadId>();
  private stopped = false;
  private run: (id: ThreadId) => Promise<void>;
  private report: (error: unknown) => void;
  constructor(run: (id: ThreadId) => Promise<void>, report: (error: unknown) => void) {
    this.run = run;
    this.report = report;
  }
  wake(id: ThreadId): void {
    if (this.stopped) return;
    if (this.tasks.has(id)) {
      this.rerun.add(id);
      return;
    }
    const task = Promise.resolve()
      .then(async () => {
        do {
          this.rerun.delete(id);
          await this.run(id);
        } while (this.rerun.has(id) && !this.stopped);
      })
      .catch((error: unknown) => this.report(error))
      .finally(() => {
        this.tasks.delete(id);
        if (this.rerun.has(id)) this.wake(id);
      });
    this.tasks.set(id, task);
  }
  get active(): boolean {
    return this.tasks.size > 0;
  }
  async flush(): Promise<void> {
    while (this.tasks.size) await Promise.all(this.tasks.values());
  }
  stop(): void {
    this.stopped = true;
  }
}
