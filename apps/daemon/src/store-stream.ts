import type { Event, EventPayload, ThreadId } from "@ace/protocol";
import { canonicalEvent } from "./canonical-event.ts";
import type { StreamSequences } from "./stream-sequences.ts";
import type { EventEncodings } from "./event-encodings.ts";
import { isStoreBusy, LiveWriteRetry } from "./store-busy.ts";
import { isDiskFull } from "./sqlite-failure.ts";
import { liveWriteRetry } from "./live-write-retry.ts";
import {
  compactDeltas,
  LiveWriteBuffer,
  type BufferScheduler,
  type BufferedSnapshot,
} from "./live-write-buffer.ts";

/** Reports a settlement's failure to the post-commit pass that owns it. */
export type FailureReport = (error: unknown) => void;

/**
 * How a write learns the fate of its rows. A top-level transaction settles before it returns.
 * One nested in an open transaction settles only when the outermost one commits or rolls back.
 */
export interface TransactionOutcome {
  /** The live buffer's rows publish in this pass before its usage notification. */
  publishes?: boolean;
  committed(report?: FailureReport): void;
  rolledBack(report?: FailureReport): void;
}

/**
 * One post-commit pass's failures. `onError` may throw; the throw is boxed by identity so a
 * settlement that sees it again, or a lineage mark inside the pass, reports it only once.
 */
export class SettlementPass {
  private readonly boxes = new WeakSet<object>();
  private failed = false;
  private failure: unknown;
  private readonly onError: (error: unknown) => void;
  constructor(onError: (error: unknown) => void) {
    this.onError = onError;
  }
  /** Report a failure; a throw from onError is boxed, recorded and rethrown internally. */
  report(error: unknown): void {
    try {
      this.onError(error);
    } catch (thrown) {
      const box = { fromOnError: thrown };
      this.boxes.add(box);
      throw box;
    }
  }
  /** Whether `error` is a box this pass produced. */
  threw(error: unknown): boolean {
    return typeof error === "object" && error !== null && this.boxes.has(error);
  }
  /** Run one step, keeping the first error while the rest still run. */
  step(action: () => void): void {
    try {
      action();
    } catch (error) {
      if (!this.failed) {
        this.failed = true;
        this.failure = error;
      }
    }
  }
  /** Throw what the first failing step threw, unwrapped, or nothing. */
  rethrow(): void {
    if (!this.failed) return;
    const error: unknown = this.failure;
    throw this.threw(error) ? (error as { fromOnError: unknown }).fromOnError : error;
  }
}

/** Settle nested outcomes, reporting each failure once through `pass` (or `onError` directly). */
export function settleOutcomes(
  settlements: { outcome: TransactionOutcome }[],
  result: "committed" | "rolledBack",
  onError: (error: unknown) => void,
  pass?: SettlementPass,
): void {
  const report = pass ? (error: unknown) => pass.report(error) : undefined;
  for (const { outcome } of settlements) {
    try {
      outcome[result](report);
    } catch (error) {
      try {
        if (pass?.threw(error)) continue;
        if (pass) pass.report(error);
        else onError(error);
      } catch {
        /* The transaction has already settled. */
      }
    }
  }
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
  // Consecutive failures that were neither contention nor a full disk; only these lead to
  // quarantine. Both of those are the store's state, not the rows': the batch waits them out.
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
    publish(events: Event[], report?: FailureReport): void;
    /** Shared with the server's wire encoder: each published event is serialised once. */
    encodings?: EventEncodings;
    report(error: unknown): void;
    /** A thread's batch could not be stored and was dropped; its session must stop. */
    quarantined(thread: ThreadId, error: Error): void;
  }) {
    this.options = privateOptions;
    this.buffer = new LiveWriteBuffer({
      scheduler: privateOptions.scheduler,
      attempt: () => this.scheduled(),
      ...(privateOptions.encodings ? { encodings: privateOptions.encodings } : {}),
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
      canonicalEvent({
        seq: (seq = this.options.sequences.next(seq)),
        id: this.options.nextId(),
        threadId: id,
        at,
        payload,
      }),
    );
    this.buffer.append(events, id, snapshot);
    try {
      const first = events[0];
      // An empty batch (liveness only) changes nothing.
      if (!first) return;
      // Reserve the actual canonical event count, including split shell output. Pin first:
      // a reservation transaction drains the buffer, and a failed drain must retain the
      // reducer's snapshot and events together without applying the facts a second time.
      this.options.sequences.prepare(events.length, first.seq - 1);
      // A range refill already committed and published this batch through the write barrier.
      if (!this.buffer.has(id)) return;
      const boundary = events.some((event) => event.payload.type !== "item.delta");
      // A batch above the confirmed reservation publishes as stored rows when its flush commits.
      const last = events.at(-1);
      if (!boundary && last && this.options.sequences.covers(last.seq)) this.publishPending();
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
      if (!waitsForStore(error)) this.strikes++;
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
      // Contention or a full disk says nothing about the rows; the whole batch retries.
      if (waitsForStore(error)) throw error;
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
        // A thread whose every row was already stored committed its snapshot with them. A thread
        // with no rows in the batch (liveness only) has no such evidence and no delta patches
        // to replay: its header and records are rewritten as they stand.
        const eventful = new Set(events.map((event) => event.threadId));
        for (const [id, snapshot] of snapshots)
          if (!recovering || written.has(id) || !eventful.has(id)) snapshot.persist();
      },
      {
        publishes: true,
        committed: (report) => {
          settled = true;
          this.sealed = false;
          this.buffer.committed(threads, published.length + stored.length);
          if (!this.buffer.size) this.publishedThrough = 0;
          this.options.publish(stored, report);
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

/** A failure that clears on its own (contention, or space freed on a full disk). */
function waitsForStore(error: unknown): boolean {
  return isStoreBusy(error) || isDiskFull(error);
}
