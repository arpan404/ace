import { Event, type EventPayload, type ThreadId } from "@ace/protocol";
import type { StreamSequences } from "./stream-sequences.ts";
import {
  compactDeltas,
  LiveWriteBuffer,
  type BufferScheduler,
  type BufferedSnapshot,
} from "./live-write-buffer.ts";

/** Thin store shell around the pinned buffer. Sequence reservation and publication share one owner. */
export class StoreStream {
  readonly buffer: LiveWriteBuffer;
  // Buffered envelopes through this sequence have reached subscribers. They are stored under
  // their own sequences, compacted (a merged row takes its span's final sequence). The held
  // suffix was never seen: it is stored uncompacted and exactly the stored rows publish after
  // commit. A live-metadata follow-up takes a fresh sequence, so every held event after it is
  // renumbered too and the stored order matches an unbuffered append.
  private publishedThrough = 0;
  flushing = false;
  resyncs = 0;
  constructor(privateOptions: {
    scheduler: BufferScheduler;
    nextId(): string;
    sequences: StreamSequences;
    blocked(): boolean;
    transaction(run: () => void, committed: () => void): void;
    /** Store an envelope under its own sequence; returns it and any follow-up rows. */
    persist(event: Event): Event[];
    /** Store an unpublished event's payload as a new append; returns every row written. */
    append(event: Event): Event[];
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
  /** The visible head. Mid-flush, held events may already be stored under newer sequences. */
  head(): number {
    const stored = this.options.sequences.head();
    return this.flushing ? Math.max(this.buffer.head ?? 0, stored) : (this.buffer.head ?? stored);
  }
  flush(): void {
    if (this.flushing || !this.buffer.size) return;
    if (this.options.blocked()) throw new Error("Store is busy");
    this.flushing = true;
    try {
      this.buffer.flush((events, snapshots, done) => {
        const split = events.findIndex((event) => event.seq > this.publishedThrough);
        const published = compactDeltas(split < 0 ? events : events.slice(0, split));
        const held = split < 0 ? [] : events.slice(split);
        let stored: Event[] = [];
        this.options.transaction(
          () => {
            // Rows other subscribers have not seen yet: follow-ups and the held suffix.
            stored = published.flatMap((event) => this.options.persist(event).slice(1));
            let renumber = stored.length > 0;
            for (const event of held) {
              const rows = renumber ? this.options.append(event) : this.options.persist(event);
              stored.push(...rows);
              renumber ||= rows.length > 1;
            }
            for (const snapshot of snapshots) snapshot.persist();
          },
          () => {
            done(published.length + stored.length);
            this.publishedThrough = 0;
            this.options.publish(stored);
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
    const events = this.buffer.after(this.publishedThrough);
    this.publishedThrough = this.buffer.head ?? this.publishedThrough;
    this.options.publish(events);
  }
}
