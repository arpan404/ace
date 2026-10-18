import type { Event, ThreadId } from "@ace/protocol";
import { liveWriteRetryDelay } from "./live-write-retry.ts";

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

const weightOf = (event: Event) => Buffer.byteLength(JSON.stringify(event)) * 8 + 512;

/** Uncommitted data is pinned, never evicted. Admission drains before reaching the hard cap. */
export class LiveWriteBuffer {
  private events: Event[] = [];
  private snapshots = new Map<ThreadId, BufferedSnapshot>();
  private cancel: (() => void) | undefined;
  private weight = 0;
  private waiters = new Set<() => void>();
  /** Consecutive failed attempts at the pinned batch; zero while healthy. */
  private failures = 0;
  readonly metrics = { flushes: 0, rows: 0, failures: 0, liveBytes: 0, peakBytes: 0 };
  constructor(privateOptions: { scheduler: BufferScheduler; attempt(): void }) {
    this.options = privateOptions;
  }
  private readonly options;
  get failed(): boolean {
    return this.failures > 0;
  }
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
  threads(): ThreadId[] {
    return [...this.snapshots.keys()];
  }
  /** The pinned batch, or one thread's share of it, in sequence order. */
  batch(thread?: ThreadId): { events: Event[]; snapshots: Map<ThreadId, BufferedSnapshot> } {
    if (thread === undefined) return { events: this.events, snapshots: this.snapshots };
    const snapshot = this.snapshots.get(thread);
    return {
      events: this.events.filter((event) => event.threadId === thread),
      snapshots: new Map(snapshot ? [[thread, snapshot]] : []),
    };
  }
  /** Whether a batch of `bytes` must drain the buffer first; refuses one that never fits. */
  overfull(bytes: number): boolean {
    // Charge both canonical events and engine append patches, including decoded UTF-16.
    // Single oversized batches never reach here (stream() size guard); this is a backstop.
    if (bytes * 8 + 4096 > 8 * 1024 * 1024) throw new Error("Store is busy");
    return this.weight + bytes * 8 + 4096 > 8 * 1024 * 1024;
  }
  /** Admission was decided before the reducer ran. The facts behind these events are already
   * applied in memory, so refusing them here would make a mailbox retry apply them twice; the
   * stream() size guard bounds the overshoot and full() drains it at once. */
  append(events: Event[], thread: ThreadId, snapshot: BufferedSnapshot): void {
    this.snapshots.set(thread, snapshot);
    for (const event of events) {
      this.weight += weightOf(event);
      this.metrics.liveBytes += Buffer.byteLength(JSON.stringify(event));
      this.events.push(event);
    }
    this.metrics.peakBytes = Math.max(this.metrics.peakBytes, this.weight);
    this.arm(75);
  }
  /** Buffered envelopes after `seq`, in order. */
  after(seq: number): Event[] {
    let start = this.events.length;
    while (start > 0 && (this.events[start - 1]?.seq ?? 0) > seq) start--;
    return this.events.slice(start);
  }
  full(): boolean {
    return this.weight >= 64 * 1024;
  }
  /** An attempt is starting: it replaces any scheduled one. */
  begin(): void {
    this.cancel?.();
    this.cancel = undefined;
  }
  /** These threads' events and snapshots are durable: release them, settling once empty. */
  committed(threads: readonly ThreadId[], rows: number): void {
    for (const thread of threads) this.snapshots.get(thread)?.committed();
    this.remove(threads);
    this.metrics.flushes++;
    this.metrics.rows += rows;
  }
  /** Quarantine: forget a thread's events and snapshot without storing them. */
  discard(thread: ThreadId): void {
    this.remove([thread]);
  }
  /** A failed attempt keeps the batch pinned and schedules the next one; returns its delay. */
  retry(): number {
    this.failures++;
    this.metrics.failures++;
    const ms = liveWriteRetryDelay(this.failures);
    this.begin();
    this.arm(ms);
    return ms;
  }
  /** Rows written for the batch were rolled back with an enclosing transaction: write again. */
  rearm(): void {
    if (this.size) this.arm(75);
  }
  /** Resolve once no failed batch is pinned, or the buffer stops. */
  async settled(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.failed) return;
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        this.waiters.delete(ready);
        reject(signal?.reason);
      };
      this.waiters.add(ready);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  private remove(threads: readonly ThreadId[]): void {
    if (threads.length >= this.snapshots.size && threads.every((id) => this.snapshots.has(id))) {
      this.events = [];
      this.snapshots.clear();
      this.weight = 0;
    } else {
      const gone = new Set(threads);
      for (const thread of gone) this.snapshots.delete(thread);
      this.events = this.events.filter((event) => !gone.has(event.threadId));
      this.weight = this.events.reduce((total, event) => total + weightOf(event), 0);
    }
    if (this.size) return;
    this.failures = 0;
    this.begin();
    this.wake();
  }
  private wake(): void {
    const ready = [...this.waiters];
    this.waiters.clear();
    for (const resolve of ready) resolve();
  }
  private arm(ms: number): void {
    this.cancel ??= this.options.scheduler.delay(() => {
      this.cancel = undefined;
      this.options.attempt();
    }, ms);
  }
  stop(): void {
    this.begin();
    this.wake();
  }
}

/** Adjacent deltas for the same thread, item, agent and field become one row of at most 4 KiB.
 * The merged row keeps the final sequence of its span. Pure: inputs are never mutated. */
export function compactDeltas(events: Event[]): Event[] {
  const rows: Event[] = [];
  for (const event of events) {
    const previous = rows.at(-1);
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
    )
      rows[rows.length - 1] = { ...event, payload: { ...next, append: p.append + next.append } };
    else rows.push(event);
  }
  return rows;
}
