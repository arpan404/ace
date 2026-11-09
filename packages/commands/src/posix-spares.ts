import type { StartTimer } from "./posix-executor.ts";
import type { Executor } from "./posix-lane-types.ts";

/** Idle threads kept for the next root, each until its idle timer runs out. */
export class SparePool {
  private readonly idle: Executor[] = [];
  private readonly limit: number;
  private readonly idleMs: number;
  private readonly timer: StartTimer;
  private readonly expire: (executor: Executor) => void;
  constructor(
    limit: number,
    idleMs: number,
    timer: StartTimer,
    expire: (executor: Executor) => void,
  ) {
    this.limit = limit;
    this.idleMs = idleMs;
    this.timer = timer;
    this.expire = expire;
  }
  get size(): number {
    return this.idle.length;
  }
  /** The most recently idled thread, if any. */
  take(): Executor | undefined {
    const executor = this.idle.pop();
    executor?.stopIdle?.();
    if (executor) executor.stopIdle = undefined;
    return executor;
  }
  /** Keeps `executor` until the idle period ends; false if the pool is full. */
  offer(executor: Executor): boolean {
    if (this.idle.length >= this.limit) return false;
    this.idle.push(executor);
    executor.stopIdle = this.timer(() => {
      if (this.remove(executor)) this.expire(executor);
    }, this.idleMs);
    return true;
  }
  /** Drops `executor` if it is idle here; whether it was. */
  remove(executor: Executor): boolean {
    const at = this.idle.indexOf(executor);
    if (at < 0) return false;
    this.idle.splice(at, 1);
    executor.stopIdle?.();
    executor.stopIdle = undefined;
    return true;
  }
}
