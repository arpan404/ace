import type { StatementSync } from "node:sqlite";
import { ThreadId, type Thread } from "@ace/protocol";

/**
 * The threads waiting on a person now. The condition repeats the partial indexes on live
 * threads (`engine_live_threads`, `thread_liveness_candidates`) word for word, so SQLite
 * reads only the threads that are not new, done or failed: the work still open, never the
 * thread history (ADR 0170).
 */
export const needsYouSeedSql = `SELECT id, updated_at FROM threads
  WHERE json_extract(client,'$.deletedAt') IS NULL AND json_extract(status,'$.state') NOT IN ('new','done','failed')
    AND json_extract(status,'$.state') = 'needs_you'`;

export interface NeedsYouSource {
  statement(sql: string): StatementSync;
  /** Changes after any rollback: what was observed in the undone writes may be wrong. */
  rollbackGeneration(): number;
}

/**
 * Every thread waiting on a person (an approval or a question) with its last activity, kept
 * current by the event writer as it folds each thread. Filled on first use by one read of
 * the live threads (`needsYouSeedSql`), and filled again the same way after a rollback,
 * since a rolled-back write may have moved a thread in or out. Until it is filled, writes
 * are not tracked: the fill reads them from the rows.
 */
export class NeedsYouThreads {
  private readonly source: NeedsYouSource;
  private threads: Map<ThreadId, number> | undefined;
  private generation = 0;
  constructor(source: NeedsYouSource) {
    this.source = source;
  }
  /** The thread was just written as `thread`; it joins or leaves the set. */
  observe(thread: Pick<Thread, "id" | "status" | "updatedAt" | "deletedAt">): void {
    if (!this.threads) return;
    if (thread.status.state === "needs_you" && thread.deletedAt === undefined)
      this.threads.set(thread.id, thread.updatedAt);
    else this.threads.delete(thread.id);
  }
  /** The thread's row is gone. */
  forget(id: ThreadId): void {
    this.threads?.delete(id);
  }
  /** Waiting threads, most recent activity first, at most `limit`. */
  list(limit: number): ThreadId[] {
    return [...this.current()]
      .toSorted(([a, aAt], [b, bAt]) => bAt - aAt || (a < b ? 1 : a > b ? -1 : 0))
      .slice(0, limit)
      .map(([id]) => id);
  }
  private current(): Map<ThreadId, number> {
    const generation = this.source.rollbackGeneration();
    if (this.threads && generation === this.generation) return this.threads;
    const threads = new Map<ThreadId, number>();
    for (const row of this.source.statement(needsYouSeedSql).all())
      threads.set(ThreadId.parse(row.id), Number(row.updated_at));
    this.threads = threads;
    this.generation = generation;
    return threads;
  }
}
