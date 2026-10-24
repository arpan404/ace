import { Event, type EventPayload, type ThreadId } from "@ace/protocol";
import type { StreamSequences } from "./stream-sequences.ts";
import { isStoreBusy, LiveWriteRetry } from "./store-busy.ts";
import { liveWriteRetry } from "./live-write-retry.ts";
import {
  compactDeltas,
  LiveWriteBuffer,
  type BufferScheduler,
  type BufferedSnapshot,
} from "./live-write-buffer.ts";

/**
 * How a write learns the fate of its rows. A top-level transaction settles before it returns.
 * One nested in an open transaction settles only when the outermost one commits or rolls back.
 */
export interface TransactionOutcome {
  committed(): void;
  rolledBack(): void;
}

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
  // The pinned batch is written inside a transaction that is still open. Writing it again
  // would duplicate its rows, so it waits for that transaction's outcome.
  private sealed = false;
  private cause: unknown;
  // Consecutive failures that were not contention; only these lead to quarantine.
  private strikes = 0;
  resyncs = 0;
  constructor(privateOptions: {
    scheduler: BufferScheduler;
    nextId(): string;
    sequences: StreamSequences;
    blocked(): boolean;
    transaction(run: () => void, outcome: TransactionOutcome): void;
    /** Store an envelope under its own sequence; returns it and any follow-up rows. */
    persist(event: Event): Event[];
    /** Store an unpublished event's payload as a new append; returns every row written. */
    append(event: Event): Event[];
    /** Whether this exact envelope (sequence and id) is already stored. */
    stored(event: Event): boolean;
    publish(events: Event[]): void;
    report(error: unknown): void;
    /** A thread's batch could not be stored and was dropped; its session must stop. */
    quarantined(thread: ThreadId, error: Error): void;
  }) {
    this.options = privateOptions;
    this.buffer = new LiveWriteBuffer({
      scheduler: privateOptions.scheduler,
      attempt: () => this.scheduled(),
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
    // Admission retries; the mailbox runs the batch again once the store can take it.
    if (this.options.blocked() || this.sealed) throw new Error("Store is busy");
    if (this.buffer.failed) throw this.waiting();
    // Over-capacity is transient backpressure, never a session failure: drain, then admit.
    if (this.buffer.overfull(bytes)) this.flush();
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
      // A failed attempt has reported itself and scheduled its retry.
      if (!this.buffer.failed) this.options.report(error);
    }
  }
  /** The visible head. Mid-flush, held events may already be stored under newer sequences. */
  head(): number {
    const stored = this.options.sequences.head();
    return this.flushing || this.sealed
      ? Math.max(this.buffer.head ?? 0, stored)
      : (this.buffer.head ?? stored);
  }
  /** Write the pinned batch now. While a failed batch waits for its retry, writers wait too. */
  flush(): void {
    if (this.flushing || this.sealed || !this.buffer.size) return;
    if (this.buffer.failed) throw this.waiting();
    // Liveness-only snapshots order no rows: while writes are held they stay pinned.
    if (this.buffer.quiet && this.options.blocked()) return;
    this.attempt();
  }
  /** Shutdown's last attempt, even while a retry is scheduled. */
  drain(): void {
    if (this.flushing || this.sealed || !this.buffer.size) return;
    this.attempt();
  }
  private scheduled(): void {
    if (this.options.blocked()) {
      // Maintenance or history publication holds writes; they drain the buffer when done.
      this.buffer.rearm();
      return;
    }
    try {
      this.attempt();
    } catch {
      // The attempt reported its failure and armed the next one.
    }
  }
  private waiting(): Error {
    return isStoreBusy(this.cause)
      ? new Error("Store is busy", { cause: this.cause })
      : new LiveWriteRetry(this.cause);
  }
  private attempt(): void {
    if (this.options.blocked()) throw new Error("Store is busy");
    const recovering = this.buffer.failed;
    const quarantined: [ThreadId, Error][] = [];
    this.buffer.begin();
    this.flushing = true;
    try {
      if (recovering && this.strikes >= liveWriteRetry.quarantineAfter)
        for (const thread of this.buffer.threads()) this.isolate(thread, quarantined);
      else this.write(undefined, recovering);
      this.cause = undefined;
      this.strikes = 0;
    } catch (error) {
      // Nothing left pinned: no retry to wait for.
      if (!this.buffer.size) throw error;
      this.cause = error;
      if (!isStoreBusy(error)) this.strikes++;
      const ms = this.buffer.retry();
      this.options.report(new Error(`Live writes failed; retrying in ${ms} ms`, { cause: error }));
      throw this.waiting();
    } finally {
      this.flushing = false;
      for (const [thread, error] of quarantined) this.options.quarantined(thread, error);
    }
  }
  /** Last resort: store a thread's share if it still can be, otherwise drop only that share. */
  private isolate(thread: ThreadId, quarantined: [ThreadId, Error][]): void {
    try {
      this.write(thread, true);
    } catch (error) {
      // Contention says nothing about the rows; the whole batch retries on the backoff.
      if (isStoreBusy(error)) throw error;
      this.buffer.discard(thread);
      quarantined.push([
        thread,
        new Error(
          "Recent output could not be saved, so this session was stopped. Resume the thread to continue.",
          { cause: error },
        ),
      ]);
    }
  }
  /** One transaction for the batch, or for one thread's share of it during recovery. */
  private write(thread: ThreadId | undefined, recovering: boolean): void {
    const { events, snapshots } = this.buffer.batch(thread);
    const threads = [...snapshots.keys()];
    const split = events.findIndex((event) => event.seq > this.publishedThrough);
    const published = compactDeltas(split < 0 ? events : events.slice(0, split));
    const held = split < 0 ? [] : events.slice(split);
    // A retry may find rows an earlier attempt already committed: those count as stored.
    const fresh = (event: Event) => !recovering || !this.options.stored(event);
    let stored: Event[] = [];
    let settled = false;
    this.options.transaction(
      () => {
        const written = new Set<ThreadId>();
        // Rows other subscribers have not seen yet: follow-ups and the held suffix.
        stored = published.filter(fresh).flatMap((event) => {
          written.add(event.threadId);
          return this.options.persist(event).slice(1);
        });
        let renumber = stored.length > 0;
        for (const event of held) {
          if (!fresh(event)) continue;
          written.add(event.threadId);
          const rows = renumber ? this.options.append(event) : this.options.persist(event);
          stored.push(...rows);
          renumber ||= rows.length > 1;
        }
        // A thread whose every row was already stored committed its snapshot with them.
        for (const [id, snapshot] of snapshots)
          if (!recovering || written.has(id)) snapshot.persist();
      },
      {
        committed: () => {
          settled = true;
          this.sealed = false;
          this.buffer.committed(threads, published.length + stored.length);
          if (!this.buffer.size) this.publishedThrough = 0;
          this.options.publish(stored);
        },
        rolledBack: () => {
          this.sealed = false;
          this.buffer.rearm();
        },
      },
    );
    if (!settled) this.sealed = true;
  }
  private publishPending(): void {
    const events = this.buffer.after(this.publishedThrough);
    this.publishedThrough = this.buffer.head ?? this.publishedThrough;
    this.options.publish(events);
  }
}
