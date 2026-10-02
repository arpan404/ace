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
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync, options: { trigrams?: boolean; readOutput?: OutputReader } = {}) {
    this.db = db;
    const trigrams = options.trigrams ?? true;
    migrateSearch(db, trigrams);
    this.writer = new SearchWriter(db, trigrams, options.readOutput);
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
    let seq = Number(this.writer.sql.get("SELECT seq FROM search_meta WHERE id=1").get()?.seq);
    const contiguous: Event[] = [];
    for (const event of events) {
      if (event.seq <= seq) continue;
      if (event.seq !== seq + 1) break;
      contiguous.push(event);
      seq = event.seq;
    }
    this.consume(contiguous, seq);
  }
  private consume(events: readonly Event[], throughSeq: number): void {
    this.atomic(() => {
      for (const event of events) this.writer.stage(event);
      this.writer.sql.run("UPDATE search_meta SET seq=? WHERE id=1", throughSeq);
      this.writer.flush("dirty=1 AND complete=1", 256);
    });
  }
  /** Current metadata wins over older replay, so a working thread cannot appear done during backfill. */
  observeThread(thread: Thread, seq: number): void {
    this.atomic(() => this.writer.observeThread(thread, seq));
  }
  flush(limit = 128): number {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error("Invalid batch size");
    return this.atomic(() => this.writer.flush("dirty=1", limit));
  }
  query(input: unknown): SearchResults {
    const generation = Number(
      this.writer.sql.get("SELECT generation FROM search_meta WHERE id=1").get()?.generation,
    );
    return querySearch(this.writer.sql, input, generation, this.writer.trigrams);
  }
  deleteThread(threadId: string): void {
    this.atomic(() => {
      for (;;) {
        const rows = this.writer.sql
          .get("SELECT item FROM search_stage WHERE thread=? LIMIT 128")
          .all(threadId);
        if (!rows.length) break;
        for (const row of rows) this.writer.deleteItem(threadId, ItemKey.parse(row).item);
      }
      this.writer.sql.run("DELETE FROM search_threads WHERE id=?", threadId);
    });
  }
  backfillBatch(source: SearchSource): SearchStatus {
    const seq = Number(this.writer.sql.get("SELECT seq FROM search_meta WHERE id=1").get()?.seq);
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
    this.consume(events, throughSeq);
    this.flush();
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
      if (status.ready) return;
      await (options.yield ?? yieldImmediate)();
    }
  }
}

export { SearchQueries } from "./query-service.ts";
