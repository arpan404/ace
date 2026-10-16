import { Event, type EventPayload, type ThreadId } from "@ace/protocol";
import type { StreamSequences } from "./stream-sequences.ts";
import {
  LiveWriteBuffer,
  type BufferScheduler,
  type BufferedSnapshot,
} from "./live-write-buffer.ts";

/** Thin store shell around the pinned buffer. Sequence reservation and publication share one owner. */
export class StoreStream {
  readonly buffer: LiveWriteBuffer;
  // References to pinned envelopes awaiting publication; compaction must never replay an
  // already delivered prefix when a durable boundary publishes the remaining suffix.
  private unpublished: Event[] = [];
  flushing = false;
  resyncs = 0;
  constructor(privateOptions: {
    scheduler: BufferScheduler;
    nextId(): string;
    sequences: StreamSequences;
    blocked(): boolean;
    transaction(run: () => void, committed: () => void): void;
    persist(event: Event): void;
    publish(events: Event[]): void;
    report(error: unknown): void;
  }) {
    this.options = privateOptions;
    this.buffer = new LiveWriteBuffer({
      scheduler: privateOptions.scheduler,
      flush: () => this.flush(),
      report: privateOptions.report,
    });
  }
  private readonly options;
  metrics() {
    return {
      ...this.buffer.metrics,
      replayResyncs: this.resyncs,
      bufferedBytes: this.buffer.bytes,
    };
  }
  replaySafe(after: number): boolean {
    this.flush();
    const safe = this.options.sequences.replaySafe(after);
    if (!safe) this.resyncs++;
    return safe;
  }
  prepare(bytes: number): void {
    if (this.options.blocked()) throw new Error("Store is busy");
    this.buffer.prepare(bytes);
    // Open a range before reducing facts. Split canonical batches that span its end are
    // checked again after admission, with their exact event count and snapshot pinned.
    try {
      this.options.sequences.prepare(1, this.buffer.head ?? this.options.sequences.head());
    } catch (error) {
      throw new Error("Store is busy", { cause: error });
    }
  }
  append(id: ThreadId, payloads: EventPayload[], at: number, snapshot: BufferedSnapshot): void {
    let seq = this.buffer.head ?? this.options.sequences.head();
    const events = payloads.map((payload) =>
      Event.parse({
        seq: (seq = this.options.sequences.next(seq)),
        id: this.options.nextId(),
        threadId: id,
        at,
        payload,
      }),
    );
    this.buffer.append(events, id, snapshot);
    this.unpublished.push(...events);
    try {
      // Reserve the actual canonical event count, including split shell output. Pin first:
      // a reservation transaction drains the buffer, and a failed drain must retain the
      // reducer's snapshot and events together without applying the facts a second time.
      const first = events[0];
      if (first) this.options.sequences.prepare(events.length, first.seq - 1);
      // A range refill already committed and published this batch through the write barrier.
      if (!this.buffer.has(id)) return;
      const boundary = events.some((event) => event.payload.type !== "item.delta");
      if (!boundary) this.publishPending();
      if (boundary || this.buffer.full()) this.flush();
    } catch (error) {
      this.options.report(error);
    }
  }
  flush(): void {
    if (this.flushing || !this.buffer.size) return;
    if (this.options.blocked()) throw new Error("Store is busy");
    this.flushing = true;
    try {
      this.buffer.flush((events, snapshots, done) => {
        this.options.transaction(
          () => {
            for (const event of events) this.options.persist(event);
            for (const snapshot of snapshots) snapshot.persist();
          },
          () => {
            done();
            this.publishPending();
          },
        );
      });
    } catch (error) {
      // Control facts and range refills force this same flush. Keep their mailbox operation
      // pending while the pinned batch retries, even when storage failed with more than BUSY.
      if (this.buffer.failed) throw new Error("Store is busy", { cause: error });
      throw error;
    } finally {
      this.flushing = false;
    }
  }
  private publishPending(): void {
    const events = this.unpublished;
    this.unpublished = [];
    this.options.publish(events);
  }
}
