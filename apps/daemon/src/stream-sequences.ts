import type { StatementSync } from "node:sqlite";
import type { FailureReport, TransactionOutcome } from "./store-stream.ts";

/**
 * The one allocator the store's writers share: the event writer's ordinary appends, the live
 * buffer and deletion tombstones. `store.ts` builds one (`StreamSequences`, or the native one
 * behind `ACE_STORE_WRITER`), so its cursor is the only cursor and a rollback can never reuse
 * a sequence. Implementations keep no second cursor of their own.
 */
export interface SequenceAllocator {
  /** Reads `host_sequence`. Nothing before this may touch SQL (the database is not migrated). */
  initialize(): void;
  /** The highest sequence a committed reservation holds; `NaN` while none has. */
  reservedThrough(): number;
  /** The larger of the event and tombstone high-water marks; 0 when both are empty. */
  head(): number;
  /** Whether a subscriber holding `after` can resume from committed state. */
  replaySafe(after: number): boolean;
  /** Allocate provisionally. The cursor moves before exhaustion throws, so nothing is reused. */
  next(after: number): number;
  /** Reserve a range for a live batch; confirmation is the outermost commit's. */
  prepare(events: number, after: number): void;
  /** Whether a committed reservation covers `seq`. */
  covers(seq: number): boolean;
}

/** Reserve ranges durably before publishing events. Old builds also skip this high-water mark, so
 * the existing host_sequence format remains readable in both directions. Every sequence handed
 * out lies inside a reserved range, and `reserved` hears of each range before it is used, so a
 * mark kept outside the database covers every sequence a client may hold (ADR 0128). */
export class StreamSequences implements SequenceAllocator {
  private cursor = 0;
  private reserved = 0;
  /** Ranges written by transactions that have not settled yet; a rollback forgets them. */
  private pending: number[] = [];
  constructor(privateOptions: {
    statement(sql: string): StatementSync;
    /** Runs the reservation; settles only when the outermost transaction that wrote it does. */
    commit(run: () => void, outcome: TransactionOutcome): void;
    /** A range through `through` is reserved by a committed transaction and about to be used. */
    reserved?(through: number, report?: FailureReport): void;
  }) {
    this.options = privateOptions;
  }
  private readonly options;
  initialize(): void {
    this.cursor = Number(
      this.options.statement("SELECT seq FROM host_sequence WHERE id=1").get()?.seq,
    );
    this.reserved = this.cursor;
    this.pending = [];
  }
  /** The highest sequence this database reserved. */
  reservedThrough(): number {
    return this.reserved;
  }
  head(): number {
    const row = this.options
      .statement(`SELECT MAX(seq) AS seq FROM (
      SELECT MAX(seq) AS seq FROM events UNION ALL SELECT MAX(seq) AS seq FROM usage_deletions
    )`)
      .get();
    return Number(row?.seq ?? 0);
  }
  replaySafe(after: number): boolean {
    const head = this.head();
    if (after > head && after > this.reserved) return false;
    return (
      after === 0 ||
      after === head ||
      !!this.options.statement("SELECT 1 FROM events WHERE seq=?").get(after)
    );
  }
  next(after: number): number {
    this.cursor = Math.max(this.cursor, after) + 1;
    if (!Number.isSafeInteger(this.cursor)) throw new Error("Sequence exhausted");
    return this.cursor;
  }
  prepare(events: number, after: number): void {
    // A range already requested covers the batch even before its transaction commits, so a
    // second admission in the same outer transaction must not ask for another refill.
    if (after + events <= this.provisional()) return;
    const through = after + Math.max(65536, events);
    if (!Number.isSafeInteger(through)) throw new Error("Sequence exhausted");
    this.pending.push(through);
    const settle = () => {
      const index = this.pending.indexOf(through);
      if (index >= 0) this.pending.splice(index, 1);
    };
    try {
      this.options.commit(
        () => {
          this.options.statement("UPDATE host_sequence SET seq=MAX(seq,?) WHERE id=1").run(through);
        },
        {
          // Only the outermost commit counts: a rollback forgets the pending range.
          committed: (report) => {
            settle();
            const raised = Number.isNaN(this.reserved) || through > this.reserved;
            this.reserved = Number.isNaN(this.reserved)
              ? through
              : Math.max(this.reserved, through);
            if (raised) this.options.reserved?.(through, report);
          },
          rolledBack: settle,
        },
      );
    } catch (error) {
      settle();
      throw error;
    }
  }
  /** The highest sequence a confirmed or pending reservation holds: the provisional range. */
  private provisional(): number {
    let limit = this.reserved;
    for (const through of this.pending)
      limit = Number.isNaN(limit) ? through : Math.max(limit, through);
    return limit;
  }
  /** Whether a committed reservation covers `seq`; false while none has committed. */
  covers(seq: number): boolean {
    return seq <= this.reserved;
  }
}
