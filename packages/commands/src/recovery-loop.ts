export type RecoveryScheduler = (run: () => Promise<boolean>) => () => void;
export type RecoveryTimer = (run: () => void, delayMs: number) => () => void;
const timer: RecoveryTimer = (run, delay) => {
  const handle = setTimeout(run, delay);
  handle.unref();
  return () => clearTimeout(handle);
};

/** One bounded recovery batch per wake, shared fairly across a library's contexts.
 * Native watchers handle normal edits. Quiet fallback checks back off to five seconds.
 */
export class RecoveryLoop {
  private readonly tasks = new Set<() => Promise<boolean>>();
  private cancel: (() => void) | undefined;
  private running = false;
  private delay = 250;
  private readonly timer: RecoveryTimer;
  constructor(schedule: RecoveryTimer = timer) {
    this.timer = schedule;
  }
  readonly schedule: RecoveryScheduler = (run) => {
    this.tasks.add(run);
    this.arm();
    return () => {
      this.tasks.delete(run);
      if (!this.tasks.size) {
        this.cancel?.();
        this.cancel = undefined;
        this.delay = 250;
      }
    };
  };
  private arm(): void {
    if (this.running || this.cancel || !this.tasks.size) return;
    this.cancel = this.timer(() => {
      this.cancel = undefined;
      void this.tick();
    }, this.delay);
  }
  private async tick(): Promise<void> {
    const run = this.tasks.values().next().value;
    if (!run) return;
    this.tasks.delete(run);
    this.tasks.add(run);
    this.running = true;
    try {
      this.delay = (await run()) ? 250 : Math.min(this.delay * 2, 5000);
    } catch {
      // Failed filesystem recovery must neither spin nor become an unhandled rejection.
      this.delay = Math.min(this.delay * 2, 5000);
    } finally {
      this.running = false;
      this.arm();
    }
  }
}
