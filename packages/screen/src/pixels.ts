import { z } from "zod";
import type { Frame } from "./frames.ts";
import type { Helper } from "./helper.ts";
import { nodeScheduler } from "./runtime.ts";

/** Capture has no polling timer. A bounded set of consumers owns the native lease. */
export class Pixels {
  private leases = 0;
  private task: Promise<void> | undefined;
  private desired = false;
  private actual = false;
  private stopped = false;
  private readonly waiters = new Set<{
    resolve(frame: Frame): void;
    reject(error: Error): void;
    cancel(): void;
    floor?: number;
  }>();
  private floor = 0;
  private latest: Frame | undefined;
  private generation = 0;
  private readonly nextGeneration: () => number;
  private readonly helper: Helper;
  private readonly indicator: (active: boolean) => void;
  private readonly failure: (error: Error) => void;
  constructor(
    helper: Helper,
    indicator: (active: boolean) => void,
    failure: (error: Error) => void,
    nextGeneration: () => number,
  ) {
    this.helper = helper;
    this.nextGeneration = nextGeneration;
    this.indicator = indicator;
    this.failure = failure;
  }
  startGeneration(): number {
    this.generation = this.nextGeneration();
    this.actual = true;
    return this.generation;
  }
  async settle(): Promise<void> {
    while (this.task) await this.task;
  }
  initialize(): Promise<void> {
    return this.set(false);
  }
  accepts(frame: Frame): boolean {
    return (
      this.helper.capabilities?.platform !== "windows" ||
      ((this.actual || this.desired) &&
        (frame.header.captureGeneration === undefined ||
          frame.header.captureGeneration === this.generation))
    );
  }
  acquire(): { ready: Promise<void>; release(): void } {
    if (this.stopped) throw new Error("Pixel session stopped");
    if (this.leases >= 80) throw new Error("Pixel lease limit");
    this.leases++;
    const ready = this.leases === 1 ? this.set(true) : (this.task ?? Promise.resolve());
    let released = false;
    return {
      ready,
      release: () => {
        if (released) return;
        released = true;
        this.leases--;
        if (!this.stopped && this.leases === 0) void this.set(false);
      },
    };
  }
  private set(active: boolean): Promise<void> {
    if (!this.helper.capabilities || this.helper.capabilities.platform.startsWith("linux"))
      return Promise.resolve();
    this.desired = active;
    if (this.task) return this.task;
    if (this.actual === active || this.stopped) return Promise.resolve();
    const task = this.drain();
    this.task = task;
    void task.catch(() => {});
    return task;
  }
  private async drain(): Promise<void> {
    try {
      while (!this.stopped && this.actual !== this.desired) {
        const active = this.desired;
        if (active) this.indicator(true);
        if (this.helper.capabilities?.platform === "windows") {
          this.generation = this.nextGeneration();
          if (active) {
            this.floor = (this.latest?.header.sequence ?? -1) + 1;
            this.latest = undefined;
          }
          await this.helper.requestV2({ op: "watch", active, captureGeneration: this.generation });
        } else {
          const data = await this.helper.request({ op: "capture", enabled: active });
          const progress = z.object({ afterSeq: z.number().int().nonnegative() }).parse(data);
          if (active) this.floor = progress.afterSeq;
        }
        this.actual = active;
        if (!active) this.indicator(false);
      }
    } catch (error) {
      this.failure(error instanceof Error ? error : new Error("Capture lease failed"));
      throw error;
    } finally {
      this.task = undefined;
    }
  }
  frame(frame: Frame): void {
    this.latest = frame;
    for (const waiter of this.waiters) {
      if (waiter.floor !== undefined && frame.header.sequence >= waiter.floor) {
        waiter.cancel();
        waiter.resolve(frame);
        this.waiters.delete(waiter);
      }
    }
  }
  async screenshot(schedule: typeof nodeScheduler, timeoutMs: number): Promise<Frame> {
    if (this.waiters.size >= 16) throw new Error("Screenshot request limit");
    const lease = this.acquire();
    let pending:
      | { resolve(frame: Frame): void; reject(error: Error): void; cancel(): void; floor?: number }
      | undefined;
    const received = new Promise<Frame>((resolve, reject) => {
      pending = {
        resolve,
        reject,
        cancel: schedule.schedule(() => reject(new Error("Screenshot timed out")), timeoutMs),
      };
      this.waiters.add(pending);
    });
    // Register a rejection handler before waiting on the native command.
    const guarded = received.then((frame) => frame);
    void guarded.catch(() => {});
    try {
      await lease.ready;
      if (pending) pending.floor = this.floor;
      if (this.latest) this.frame(this.latest);
      return await guarded;
    } finally {
      if (pending) {
        pending.cancel();
        this.waiters.delete(pending);
      }
      lease.release();
    }
  }
  stop(error = new Error("Pixel session stopped")): void {
    this.stopped = true;
    this.latest = undefined;
    for (const waiter of this.waiters) {
      waiter.cancel();
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}
