import type { Event, ThreadId } from "@ace/protocol";

export interface BufferedSnapshot {
  persist(): void;
  committed(): void;
}
export interface BufferScheduler {
  delay(callback: () => void, ms: number): () => void;
}
export const bufferScheduler: BufferScheduler = {
  delay(callback, ms) {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** Uncommitted data is pinned, never evicted. Admission drains before reaching the hard cap. */
export class LiveWriteBuffer {
  private events: Event[] = [];
  private snapshots = new Map<ThreadId, BufferedSnapshot>();
  private cancel: (() => void) | undefined;
  private weight = 0;
  failed = false;
  readonly metrics = { flushes: 0, rows: 0, failures: 0, liveBytes: 0, peakBytes: 0 };
  constructor(privateOptions: {
    scheduler: BufferScheduler;
    flush(): void;
    report(error: unknown): void;
  }) {
    this.options = privateOptions;
  }
  private readonly options;
  get size(): number {
    return this.snapshots.size;
  }
  get bytes(): number {
    return this.weight;
  }
  get head(): number | undefined {
    return this.events.at(-1)?.seq;
  }
  has(thread: ThreadId): boolean {
    return this.snapshots.has(thread);
  }
  prepare(bytes: number): void {
    // Charge both canonical events and engine append patches, including decoded UTF-16.
    if (this.failed) this.options.flush();
    if (this.weight + bytes * 8 + 4096 > 8 * 1024 * 1024) this.options.flush();
    if (bytes * 8 + 4096 > 8 * 1024 * 1024) throw new Error("Live write capacity exceeded");
  }
  append(events: Event[], thread: ThreadId, snapshot: BufferedSnapshot): void {
    const incoming = events.reduce(
      (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) * 8 + 512,
      0,
    );
    if (this.weight + incoming > 8 * 1024 * 1024) throw new Error("Live write capacity exceeded");
    this.snapshots.set(thread, snapshot);
    for (const event of events) {
      const bytes = Buffer.byteLength(JSON.stringify(event));
      this.weight += bytes * 8 + 512;
      this.metrics.liveBytes += bytes;
      const previous = this.events.at(-1);
      const p = previous?.payload;
      const next = event.payload;
      if (
        previous &&
        p?.type === "item.delta" &&
        next.type === "item.delta" &&
        previous.threadId === event.threadId &&
        p.itemId === next.itemId &&
        p.agentId === next.agentId &&
        p.field === next.field &&
        Buffer.byteLength(p.append) + Buffer.byteLength(next.append) <= 4096
      ) {
        this.events[this.events.length - 1] = {
          ...event,
          payload: { ...next, append: p.append + next.append },
        };
      } else this.events.push(event);
    }
    this.metrics.peakBytes = Math.max(this.metrics.peakBytes, this.weight);
    this.arm(75);
  }
  full(): boolean {
    return this.weight >= 64 * 1024;
  }
  flush(
    commit: (events: Event[], snapshots: Iterable<BufferedSnapshot>, done: () => void) => void,
  ): void {
    if (!this.snapshots.size) return;
    this.cancel?.();
    this.cancel = undefined;
    try {
      commit(this.events, this.snapshots.values(), () => {
        for (const snapshot of this.snapshots.values()) snapshot.committed();
        this.failed = false;
        this.metrics.flushes++;
        this.metrics.rows += this.events.length;
        this.events = [];
        this.snapshots.clear();
        this.weight = 0;
      });
    } catch (error) {
      this.failed = true;
      this.metrics.failures++;
      this.arm(100);
      throw error;
    }
  }
  private arm(ms: number): void {
    this.cancel ??= this.options.scheduler.delay(() => {
      this.cancel = undefined;
      try {
        this.options.flush();
      } catch (error) {
        this.options.report(error);
      }
    }, ms);
  }
  stop(): void {
    this.cancel?.();
    this.cancel = undefined;
  }
}
