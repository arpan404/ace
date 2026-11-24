// SPDX-License-Identifier: Apache-2.0
//! The live buffer behind `ACE_STORE_WRITER=live` (phases 5.4a and 5.4b). Delta compaction and
//! the retry delay come from `ace_store::writer::live`; so does the buffer's state — weights,
//! the 64 KiB flush-now rule, the 8 MiB ceiling, the 75 ms and 1 s deadlines, the failure count
//! and the retirement of a stored batch. This file holds the event objects, the snapshot objects
//! and the timer, and schedules the deadlines the buffer returns on the owning thread between
//! JavaScript turns (ADR 0222 §3).

import { appendFileSync } from "node:fs";
import { storeWriterOn } from "@ace/provider-kit/native-switches";
import { nativeCall, nativeHandle } from "@ace/provider-kit/sqlite";
import type { DatabaseSync } from "@ace/provider-kit/sqlite";
import type { Event, ThreadId } from "@ace/protocol";
import {
  compactDeltas as compactDeltasTypeScript,
  type BufferMetrics,
  type BufferScheduler,
  type BufferedSnapshot,
  type LiveBuffer,
} from "../live-write-buffer.ts";
import { liveWriteRetryDelay } from "../live-write-retry.ts";
import { EventEncodings } from "../event-encodings.ts";

/** The addon's `NativeLiveBuffer` (`native/daemon/.../writer.rs`). */
interface NativeBuffer {
  /** `[seq, bytes]` pairs; a deadline in ms, or null when the armed one stands. */
  append(thread: string, events: number[]): number | null;
  /** Says whether a timer was armed, so this shell cancels it. */
  begin(): boolean;
  /** JSON `{ size, cancelled, woke }`. */
  committed(threads: string[], rows: number): string;
  /** JSON `{ size, cancelled, woke }`. */
  discard(thread: string): string;
  retry(): number;
  rearm(): number | null;
  fired(): boolean;
  stop(): boolean;
  failed(): boolean;
  size(): number;
  quiet(): boolean;
  bytes(): number;
  head(): number | null;
  has(thread: string): boolean;
  /** JSON array of thread keys, in first-insertion order. */
  threads(): string;
  after(seq: number): number;
  full(): boolean;
  /** True to drain first; throws "Store is busy" for a batch that can never fit. */
  overfull(bytes: number): boolean;
  /** JSON `{ flushes, rows, failures, liveBytes, peakBytes }`. */
  metrics(): string;
}

/** The addon's live methods on its database handle (`native/daemon/.../writer.rs`). */
interface NativeLive {
  /** Events as JSON text in; the compacted rows as JSON text out. */
  compactDeltas(events: string): string;
  /** The `failures`-th failure's delay in ms: a deadline, never a timer here. */
  liveRetryDelay(failures: number): number;
  /** This store stream's buffer, empty and unarmed. */
  liveBuffer(): NativeBuffer;
}

function binding(db: DatabaseSync): NativeLive {
  const handle = nativeHandle(db as unknown as object) as unknown as NativeLive | undefined;
  if (!handle) throw new Error("ACE_STORE=native needs the store addon");
  return handle;
}

/** The native live part ran at least once in this process (the proof's evidence file). */
let evidenceWritten = false;

/** Appends one line to `ACE_STORE_WRITER_EVIDENCE` on the first native live call, when set. */
function recordEvidence(): void {
  if (evidenceWritten) return;
  const path = process.env.ACE_STORE_WRITER_EVIDENCE;
  if (path === undefined) return;
  evidenceWritten = true;
  appendFileSync(path, `${process.pid} live\n`);
}

/** `compactDeltas` with the switch off; with it on, the Rust compaction. */
export function compactDeltas(db: DatabaseSync, events: Event[]): Event[] {
  if (!storeWriterOn("live")) return compactDeltasTypeScript(events);
  const text = nativeCall(() => binding(db).compactDeltas(JSON.stringify(events)));
  recordEvidence();
  return JSON.parse(text) as Event[];
}

/** `liveWriteRetryDelay` with the switch off; with it on, the Rust rule. */
export function retryDelay(db: DatabaseSync, failures: number): number {
  if (!storeWriterOn("live")) return liveWriteRetryDelay(failures);
  const ms = nativeCall(() => binding(db).liveRetryDelay(failures));
  recordEvidence();
  return ms;
}

/** What a removal left behind: the buffer's size, and whether a timer or a waiter must move. */
interface Removal {
  size: number;
  cancelled: boolean;
  woke: boolean;
}

/**
 * `LiveWriteBuffer` with its bookkeeping in Rust. Every decision is the native buffer's; this
 * class holds the pinned events and snapshots in the buffer's order, arms the deadline it
 * returns, and resolves `settled`'s waiters.
 */
export class NativeLiveBuffer implements LiveBuffer {
  private readonly handle: NativeBuffer;
  private readonly options;
  private readonly encodings: EventEncodings;
  /** The pinned events, in the same order as the buffer's entries. */
  private events: Event[] = [];
  private snapshots = new Map<ThreadId, BufferedSnapshot>();
  private cancel: (() => void) | undefined;
  private waiters = new Set<() => void>();
  constructor(privateOptions: {
    readonly db: DatabaseSync;
    scheduler: BufferScheduler;
    attempt(): void;
    /** Shared with the server's wire encoder: each event is serialised once. */
    encodings?: EventEncodings;
  }) {
    this.options = privateOptions;
    this.encodings = privateOptions.encodings ?? new EventEncodings();
    this.handle = nativeCall(() => binding(privateOptions.db).liveBuffer());
    recordEvidence();
  }
  get failed(): boolean {
    return this.call((buffer) => buffer.failed());
  }
  get size(): number {
    return this.call((buffer) => buffer.size());
  }
  get quiet(): boolean {
    return this.call((buffer) => buffer.quiet());
  }
  get bytes(): number {
    return this.call((buffer) => buffer.bytes());
  }
  get head(): number | undefined {
    return this.call((buffer) => buffer.head()) ?? undefined;
  }
  get metrics(): BufferMetrics {
    return JSON.parse(this.call((buffer) => buffer.metrics())) as BufferMetrics;
  }
  has(thread: ThreadId): boolean {
    return this.call((buffer) => buffer.has(thread));
  }
  threads(): ThreadId[] {
    return JSON.parse(this.call((buffer) => buffer.threads())) as ThreadId[];
  }
  /** The pinned batch, or one thread's share of it, in sequence order. */
  batch(thread?: ThreadId): { events: Event[]; snapshots: Map<ThreadId, BufferedSnapshot> } {
    const snapshots = new Map<ThreadId, BufferedSnapshot>();
    if (thread !== undefined) {
      const snapshot = this.snapshots.get(thread);
      if (snapshot && this.has(thread)) snapshots.set(thread, snapshot);
      return {
        events: this.events.filter((event) => event.threadId === thread),
        snapshots,
      };
    }
    for (const id of this.threads()) {
      const snapshot = this.snapshots.get(id);
      if (snapshot) snapshots.set(id, snapshot);
    }
    return { events: this.events, snapshots };
  }
  /** Whether a batch of `bytes` must drain first; a batch that never fits throws "Store is busy". */
  overfull(bytes: number): boolean {
    return this.call((buffer) => buffer.overfull(bytes));
  }
  append(events: Event[], thread: ThreadId, snapshot: BufferedSnapshot): void {
    const pairs: number[] = [];
    for (const event of events) pairs.push(event.seq, this.encodings.bytes(event));
    const ms = this.call((buffer) => buffer.append(thread, pairs));
    this.snapshots.set(thread, snapshot);
    for (const event of events) this.events.push(event);
    if (ms !== null) this.arm(ms);
  }
  /** Buffered envelopes after `seq`, in order. */
  after(seq: number): Event[] {
    return this.events.slice(this.call((buffer) => buffer.after(seq)));
  }
  full(): boolean {
    return this.call((buffer) => buffer.full());
  }
  /** An attempt is starting: it replaces any scheduled one. */
  begin(): void {
    if (this.call((buffer) => buffer.begin())) this.disarm();
  }
  /** These threads' events and snapshots are durable: release them, settling once empty. */
  committed(threads: readonly ThreadId[], rows: number): void {
    for (const thread of threads) this.snapshots.get(thread)?.committed();
    const removal = this.removal((buffer) => buffer.committed([...threads], rows));
    this.settle(threads, removal);
  }
  /** Quarantine: forget a thread's events and snapshot without storing them. */
  discard(thread: ThreadId): void {
    const removal = this.removal((buffer) => buffer.discard(thread));
    this.settle([thread], removal);
  }
  /** A failed attempt keeps the batch pinned and schedules the next one; returns its delay. */
  retry(): number {
    const ms = this.call((buffer) => buffer.retry());
    this.arm(ms);
    return ms;
  }
  /** Rows written for the batch were rolled back with an enclosing transaction: write again. */
  rearm(): void {
    const ms = this.call((buffer) => buffer.rearm());
    if (ms !== null) this.arm(ms);
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
  stop(): void {
    if (this.call((buffer) => buffer.stop())) this.disarm();
    this.wake();
  }
  /** One call into the addon: the evidence line appears only after it succeeds. */
  private call<T>(run: (buffer: NativeBuffer) => T): T {
    const result = nativeCall(() => run(this.handle));
    recordEvidence();
    return result;
  }
  private removal(run: (buffer: NativeBuffer) => string): Removal {
    return JSON.parse(this.call(run)) as Removal;
  }
  /** Apply what the buffer removed to the events, the snapshots, the timer and the waiters. */
  private settle(threads: readonly ThreadId[], removal: Removal): void {
    if (removal.cancelled) this.disarm();
    if (removal.size === 0) {
      this.events = [];
      this.snapshots.clear();
    } else {
      const gone = new Set(threads);
      this.snapshots = new Map([...this.snapshots].filter(([id]) => !gone.has(id)));
      this.events = this.events.filter((event) => !gone.has(event.threadId));
    }
    if (removal.woke) this.wake();
  }
  private wake(): void {
    const ready = [...this.waiters];
    this.waiters.clear();
    for (const resolve of ready) resolve();
  }
  /** Schedule the buffer's deadline; `cancel` always holds the one timer the buffer armed. */
  private arm(ms: number): void {
    this.disarm();
    this.cancel = this.options.scheduler.delay(() => {
      this.cancel = undefined;
      // The deadline has fired, so a later `rearm` arms a fresh timer rather than keeping this.
      this.call((buffer) => buffer.fired());
      this.options.attempt();
    }, ms);
  }
  private disarm(): void {
    this.cancel?.();
    this.cancel = undefined;
  }
}
