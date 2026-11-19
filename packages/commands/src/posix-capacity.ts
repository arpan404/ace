import type { PosixLimits } from "./posix-executor.ts";

/**
 * How many threads exist and how many are stuck, and so whether another may start. Pure counts:
 * the lanes report each start, stall and exit.
 */
export class LaneCapacity {
  /** Threads serving a root or waiting as a spare. */
  private live = 0;
  /** Threads started and not yet confirmed stopped, draining ones included. */
  private allocated = 0;
  private drainingTotal = 0;
  private readonly draining = new Map<string, number>();
  private readonly settles = new Map<string, (() => void)[]>();

  threads(): number {
    return this.allocated;
  }
  /** Draining threads that count against `root`. */
  stuck(root: string): number {
    return this.draining.get(root) ?? 0;
  }
  /** Whether stuck threads leave room to start one: they may fill only the reserve. */
  mayStart(limits: PosixLimits): boolean {
    const reserve = Math.max(1, limits.maxThreads - limits.maxWorkers);
    return this.drainingTotal < reserve;
  }
  /** Whether a new thread fits every cap now. */
  canStart(limits: PosixLimits): boolean {
    return (
      this.live < limits.maxWorkers && this.allocated < limits.maxThreads && this.mayStart(limits)
    );
  }
  started(): void {
    this.live++;
    this.allocated++;
  }
  /** A thread stops serving (retired, failed or draining); it still counts until it exits. */
  stoppedServing(): void {
    this.live--;
  }
  /** A serving thread was abandoned under `root`. */
  drained(root: string): void {
    this.live--;
    this.drainingTotal++;
    this.draining.set(root, this.stuck(root) + 1);
  }
  /** A thread has exited; if it was draining under `root`, that root may settle. */
  exited(root: string | undefined): void {
    this.allocated--;
    if (root === undefined) return;
    const left = this.stuck(root) - 1;
    this.drainingTotal--;
    if (left > 0) return void this.draining.set(root, left);
    this.draining.delete(root);
    for (const resolve of this.settles.get(root) ?? []) resolve();
    this.settles.delete(root);
  }
  /** Resolves once `root` has no draining thread, so nothing abandoned there can still land. */
  settled(root: string): Promise<void> {
    if (!this.draining.has(root)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.settles.get(root) ?? [];
      list.push(resolve);
      this.settles.set(root, list);
    });
  }
}
