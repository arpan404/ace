import { Event, type EventPayload, type ThreadId } from "@ace/protocol";
import {
  LiveWriteBuffer,
  type BufferScheduler,
  type BufferedSnapshot,
} from "./live-write-buffer.ts";

/** Thin store shell around the pinned buffer. Sequence reservation and publication share one owner. */
export class StoreStream {
  readonly buffer: LiveWriteBuffer;
  flushing = false;
  resyncs = 0;
  constructor(privateOptions: {
    scheduler: BufferScheduler;
    nextId(): string;
    nextSeq(after: number): number;
    head(): number;
    replaySafe(after: number): boolean;
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
    const safe = this.options.replaySafe(after);
    if (!safe) this.resyncs++;
    return safe;
  }
  prepare(bytes: number): void {
    if (this.options.blocked()) throw new Error("Store is busy");
    this.buffer.prepare(bytes);
  }
  append(id: ThreadId, payloads: EventPayload[], at: number, snapshot: BufferedSnapshot): void {
    let seq = this.buffer.head ?? this.options.head();
    const events = payloads.map((payload) =>
      Event.parse({
        seq: (seq = this.options.nextSeq(seq)),
        id: this.options.nextId(),
        threadId: id,
        at,
        payload,
      }),
    );
    this.buffer.append(events, id, snapshot);
    const boundary = events.some((event) => event.payload.type !== "item.delta");
    if (!boundary) this.options.publish(events);
    if (boundary || this.buffer.full()) {
      try {
        this.flush();
      } catch (error) {
        this.options.report(error);
      }
    }
  }
  flush(): void {
    if (this.flushing || !this.buffer.size) return;
    if (this.options.blocked()) throw new Error("Store is busy");
    this.flushing = true;
    try {
      this.buffer.flush((events, snapshots, done) => {
        this.options.transaction(() => {
          for (const event of events) this.options.persist(event);
          for (const snapshot of snapshots) snapshot.persist();
        }, done);
      });
    } finally {
      this.flushing = false;
    }
  }
}
