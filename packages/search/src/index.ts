import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import {
  SearchStatus,
  type Event,
  type SearchResults,
  type Thread,
  type ThreadId,
} from "@ace/protocol";
import { migrateThreadSearch } from "./thread-schema.ts";
import { ThreadSearchWriter } from "./thread-writer.ts";
import { queryThreadSearch, type ThreadSearchContext } from "./thread-query.ts";
export type { ThreadSearchContext } from "./thread-query.ts";
import { migrateSearch } from "./schema.ts";
import { SearchWriter } from "./writer.ts";
import { querySearch } from "./query.ts";
import type { OutputReader } from "./output.ts";
export type { OutputReader } from "./output.ts";
export { FIELD_CAP, GAP } from "./text.ts";

const ItemKey = z.object({ item: z.string() });

export interface SearchSource {
  headSeq(): number;
  getThread?(id: ThreadId): Thread | undefined;
  readEvents(options: { afterSeq: number; limit: number }): Event[];
}
/** The caller owns the connection and event append transaction. */
export class SearchIndex {
  private readonly writer: SearchWriter;
  private readonly full: ThreadSearchWriter;
  private backfillProgress = 0;
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync, options: { trigrams?: boolean; readOutput?: OutputReader } = {}) {
    this.db = db;
    const trigrams = options.trigrams ?? true;
    migrateSearch(db, trigrams);
    this.writer = new SearchWriter(db, trigrams, options.readOutput);
    migrateThreadSearch(db);
    this.full = new ThreadSearchWriter(this.writer.sql, options.readOutput);
  }
  private atomic<T>(run: () => T): T {
    this.db.exec("SAVEPOINT search_batch");
    try {
      const result = run();
      this.db.exec("RELEASE search_batch");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO search_batch; RELEASE search_batch");
      throw error;
    }
  }
  status(headSeq: number): SearchStatus {
    const meta = this.writer.sql.get("SELECT * FROM search_meta WHERE id=1").get();
    return SearchStatus.parse({
      indexedSeq: meta?.seq,
      headSeq,
      pending: meta?.pending,
      indexWrites: meta?.writes,
      generation: meta?.generation,
      ready: meta?.seq === headSeq && meta?.pending === 0,
    });
  }
  /** If history is pending, the append-only source log remains the durable queue. */
  append(events: readonly Event[]): void {
    let seq = Math.min(
      Number(this.writer.sql.get("SELECT seq FROM search_meta WHERE id=1").get()?.seq),
      this.full.seq(),
    );
    const contiguous: Event[] = [];
    for (const event of events) {
      if (event.seq <= seq) continue;
      if (event.seq !== seq + 1) break;
      contiguous.push(event);
      seq = event.seq;
    }
    this.consume(contiguous, seq);
  }
  private consume(events: readonly Event[], throughSeq: number): number {
    return this.atomic(() => {
      const existingSeq = Number(
        this.writer.sql.get("SELECT seq FROM search_meta WHERE id=1").get()?.seq,
      );
      const fullSeq = this.full.seq();
      for (const event of events) {
        if (event.seq > existingSeq) this.writer.stage(event);
        if (event.seq > fullSeq) this.full.stage(event);
      }
      this.writer.sql.run("UPDATE search_meta SET seq=MAX(seq,?) WHERE id=1", throughSeq);
      this.full.advance(Math.max(fullSeq, throughSeq));
      const progress = this.full.flush(128);
      this.writer.flush("dirty=1 AND complete=1", 256);
      return progress;
    });
  }
  /** Current metadata wins over older replay, so a working thread cannot appear done during backfill. */
  observeThread(thread: Thread, seq: number): void {
    if (thread.deletedAt !== undefined) this.deleteThread(thread.id);
    else this.atomic(() => this.writer.observeThread(thread, seq));
  }
  flush(limit = 128): number {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error("Invalid batch size");
    return this.atomic(() => {
      this.full.flush(limit);
      return this.writer.flush("dirty=1", limit);
    });
  }
  query(input: unknown): SearchResults {
    const generation = Number(
      this.writer.sql.get("SELECT generation FROM search_meta WHERE id=1").get()?.generation,
    );
    return querySearch(this.writer.sql, input, generation, this.writer.trigrams);
  }
  threadQuery(input: unknown, context: ThreadSearchContext) {
    return this.atomic(() => queryThreadSearch(this.writer.sql, input, context));
  }
  /** Physical retention owns this missing canonical sequence, in its transaction. */
  acknowledgeDeletion(seq: number): void {
    const through = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(seq);
    this.atomic(() => {
      this.writer.sql.run(
        "UPDATE search_meta SET seq=? WHERE id=1 AND seq=?",
        through,
        through - 1,
      );
      if (this.full.seq() === through - 1) this.full.advance(through);
    });
  }
  deleteThread(threadId: string): void {
    this.atomic(() => {
      this.writer.sql.run("INSERT OR IGNORE INTO search_tombstones VALUES (?)", threadId);
      for (;;) {
        const rows = this.writer.sql
          .get("SELECT item FROM search_stage WHERE thread=? LIMIT 128")
          .all(threadId);
        if (!rows.length) break;
        for (const row of rows) this.writer.deleteItem(threadId, ItemKey.parse(row).item);
      }
      for (;;) {
        const rows = this.writer.sql
          .get("SELECT item FROM search_full_items WHERE thread=? LIMIT 128")
          .all(threadId);
        if (!rows.length) break;
        for (const row of rows) this.full.deleteItem(threadId, ItemKey.parse(row).item);
      }
      this.writer.sql.run("DELETE FROM search_threads WHERE id=?", threadId);
    });
  }
  backfillBatch(source: SearchSource): SearchStatus {
    const seq = Math.min(
      Number(this.writer.sql.get("SELECT seq FROM search_meta WHERE id=1").get()?.seq),
      this.full.seq(),
    );
    const events = source.readEvents({ afterSeq: seq, limit: 256 });
    if (source.getThread) {
      const metadataThreads = new Set(
        events
          .filter(
            (event) =>
              event.payload.type === "thread.created" || event.payload.type === "thread.updated",
          )
          .map((event) => event.threadId),
      );
      const head = source.headSeq();
      for (const id of metadataThreads) {
        const current = source.getThread(id);
        if (current) this.observeThread(current, head);
      }
    }
    // The durable source covers missing sequences left by thread retention. Live
    // append cannot make this guarantee and waits for replay across such gaps.
    const throughSeq = events.length < 256 ? source.headSeq() : (events.at(-1)?.seq ?? seq);
    const progress = this.consume(events, throughSeq);
    this.backfillProgress =
      progress +
      this.atomic(() => {
        const fullProgress = this.full.flush(128);
        this.writer.flush("dirty=1", 128);
        return fullProgress;
      });
    return this.status(source.headSeq());
  }
  async rebuild(
    source: SearchSource,
    options: Parameters<SearchIndex["backfill"]>[1],
  ): Promise<void> {
    if (options.signal.aborted) return;
    this.atomic(() => {
      for (const table of this.writer.trigrams
        ? ["search_prose", "search_titles", "search_trigram", "search_title_trigram"]
        : ["search_prose", "search_titles"])
        this.writer.sql.run(`INSERT INTO ${table}(${table}) VALUES ('delete-all')`);
      this.writer.sql.run("DELETE FROM search_docs");
      this.writer.sql.run("DELETE FROM search_stage");
      this.full.reset();
      this.writer.sql.run("UPDATE search_meta SET seq=0,generation=generation+1 WHERE id=1");
    });
    await this.backfill(source, options);
  }
  async backfill(
    source: SearchSource,
    options: {
      signal: AbortSignal;
      yield?: () => Promise<void>;
      onProgress?: (status: SearchStatus) => void;
    },
  ): Promise<void> {
    while (!options.signal.aborted) {
      const status = this.backfillBatch(source);
      options.onProgress?.(status);
      if (
        status.ready &&
        this.full.seq() === source.headSeq() &&
        this.writer.sql.get("SELECT pending FROM search_full_meta WHERE id=1").get()?.pending === 0
      )
        return;
      // A missing stream is pending, not ready. The periodic writer retries it
      // without keeping startup in an immediate-yield busy loop.
      if (status.ready && this.full.seq() === source.headSeq() && this.backfillProgress === 0)
        return;
      await (options.yield ?? yieldImmediate)();
    }
  }
}

export { SearchQueries } from "./query-service.ts";
export type { SearchWorker, SearchWorkerFactory } from "./worker-runtime.ts";
