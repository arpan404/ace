import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  fetchChunks,
  fetchExistence,
  fetchHeads,
  fetchNeighborSeqs,
  fetchRangeBodies,
  fetchTailHeads,
  fetchTarget,
  type ChunkRow,
  type RangeBodyRow,
} from "./native-reads/items.ts";

/**
 * The item store's leaf reads (docs/store/porting-guide.md phase 1b): one method per
 * statement the page loaders issue. The loaders' loops, budgets, clips and shaping call
 * these and nothing else, so behaviour is identical by construction; only the data source
 * differs. `TsItemRows` issues today's statements one by one; `NativeItemRows` runs the
 * same reads as Rust batches on the store's own connection. Statement counts per method
 * are noted; batching beyond one call lives in the loaders' priming, never here.
 */
export interface ItemRows {
  /** Page heads, newest first (validated by the loader). TS: 1 statement; native: 1 call, 1. */
  wireHeads(threadId: string, before: number, limitPlus1: number): unknown[];
  /** Page heads without the type; columns coerced as the loader's budget does. */
  pageHeads(threadId: string, before: number, limitPlus1: number): PageHeadRow[];
  /** Whole bodies in a creation range. TS: 1 statement; native: 1 call, 1 statement. */
  rangeBodies(threadId: string, oldest: number, before: number): RangeBodyRow[];
  /** Text chunks for ids, in `(item_id, seq)` order. TS: 1 statement per id; native: 1 call. */
  chunksFor(ids: readonly string[]): ChunkRow[];
  /** A tail's head rows, concatenated as the loader concatenates them (validated by the
   * loader). TS: up to 3 statements; native: 1 call, up to 3 statements. */
  tailHeads(threadId: string, rootAgentId: string | undefined, limit: number): unknown[];
  /** The window's jump point. TS: up to 2 statements; native: 1 call, up to 2 statements. */
  windowTarget(threadId: string, aroundSeq: number): number | null;
  /** Neighbor sequences around the jump point. TS: 2 statements; native: 1 call, 2. */
  windowNeighbors(
    threadId: string,
    targetSeq: number,
    before: number,
    after: number,
  ): { older: number[]; newer: number[] };
  /** Whether rows exist outside `[first, last]`. TS: 2 statements; native: 1 call, 2. */
  windowExistence(
    threadId: string,
    first: number,
    last: number,
  ): { hasBefore: boolean; hasAfter: boolean };
}

/** A page head: the loader coerces each column exactly as its statement read did. */
export interface PageHeadRow {
  id: unknown;
  created_seq: unknown;
  size: unknown;
}

/** The leaf reads as the loaders issue them today, one statement at a time. */
export class TsItemRows implements ItemRows {
  private readonly statement: (sql: string) => StatementSync;
  constructor(statement: (sql: string) => StatementSync) {
    this.statement = statement;
  }
  wireHeads(threadId: string, before: number, limitPlus1: number): unknown[] {
    return this.statement(
      "SELECT id, created_seq, size, item_type FROM item_heads WHERE thread_id = ? AND created_seq < ? ORDER BY created_seq DESC LIMIT ?",
    ).all(threadId, before, limitPlus1);
  }
  pageHeads(threadId: string, before: number, limitPlus1: number): PageHeadRow[] {
    // Coercions match the loader's own budget math exactly; corrupt values flow through the
    // same Number()/String() calls either way.
    return this.statement(
      "SELECT id, created_seq, size FROM item_heads WHERE thread_id = ? AND created_seq < ? ORDER BY created_seq DESC LIMIT ?",
    )
      .all(threadId, before, limitPlus1)
      .map((row) => ({
        id: String(row.id),
        created_seq: Number(row.created_seq),
        size: Number(row.size),
      }));
  }
  rangeBodies(threadId: string, oldest: number, before: number): RangeBodyRow[] {
    return this.statement(
      "SELECT id, item, created_seq FROM items WHERE thread_id = ? AND created_seq >= ? AND created_seq < ? ORDER BY created_seq",
    )
      .all(threadId, oldest, before)
      .map((row) => ({ id: String(row.id), item: row.item, created_seq: Number(row.created_seq) }));
  }
  chunksFor(ids: readonly string[]): ChunkRow[] {
    const out: ChunkRow[] = [];
    for (const id of ids)
      for (const row of this.statement(
        "SELECT seq, field, append FROM item_text_chunks WHERE item_id = ? ORDER BY seq",
      ).iterate(id))
        out.push({
          item_id: String(id),
          seq: Number(row.seq),
          field: row.field,
          append: row.append,
        });
    return out;
  }
  tailHeads(threadId: string, rootAgentId: string | undefined, limit: number): unknown[] {
    const columns = "SELECT id, created_seq, size, agent_id FROM item_heads WHERE thread_id = ?";
    // The root lane is the root agent's items and the thread's own (no agent): one indexed
    // read each, never one IN query, which would sort the whole lane.
    const lane = (agentId: string) =>
      this.statement(`${columns} AND agent_id = ? ORDER BY created_seq DESC LIMIT ?`).all(
        threadId,
        agentId,
        Math.floor(limit / 2),
      );
    return [
      ...this.statement(`${columns} ORDER BY created_seq DESC LIMIT ?`).all(threadId, limit + 1),
      ...(rootAgentId === undefined ? [] : lane(rootAgentId)),
      ...lane(""),
    ];
  }
  windowTarget(threadId: string, aroundSeq: number): number | null {
    const target =
      this.statement(
        "SELECT created_seq FROM item_heads WHERE thread_id=? AND created_seq>=? ORDER BY created_seq LIMIT 1",
      ).get(threadId, aroundSeq) ??
      this.statement(
        "SELECT created_seq FROM item_heads WHERE thread_id=? ORDER BY created_seq DESC LIMIT 1",
      ).get(threadId);
    return target ? Number(target.created_seq) : null;
  }
  windowNeighbors(
    threadId: string,
    targetSeq: number,
    before: number,
    after: number,
  ): { older: number[]; newer: number[] } {
    const older = this.statement(
      "SELECT created_seq FROM item_heads WHERE thread_id=? AND created_seq<? ORDER BY created_seq DESC LIMIT ?",
    ).all(threadId, targetSeq, before);
    const newer = this.statement(
      "SELECT created_seq FROM item_heads WHERE thread_id=? AND created_seq>? ORDER BY created_seq LIMIT ?",
    ).all(threadId, targetSeq, after);
    return {
      older: older.map((row) => Number(row.created_seq)),
      newer: newer.map((row) => Number(row.created_seq)),
    };
  }
  windowExistence(
    threadId: string,
    first: number,
    last: number,
  ): { hasBefore: boolean; hasAfter: boolean } {
    return {
      hasBefore:
        this.statement("SELECT 1 FROM item_heads WHERE thread_id=? AND created_seq<? LIMIT 1").get(
          threadId,
          first,
        ) !== undefined,
      hasAfter:
        this.statement("SELECT 1 FROM item_heads WHERE thread_id=? AND created_seq>? LIMIT 1").get(
          threadId,
          last,
        ) !== undefined,
    };
  }
}

/** The same leaf reads as Rust batches on the store's own connection. */
export class NativeItemRows implements ItemRows {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  wireHeads(threadId: string, before: number, limitPlus1: number): unknown[] {
    return fetchHeads(this.db, threadId, before, limitPlus1);
  }
  pageHeads(threadId: string, before: number, limitPlus1: number): PageHeadRow[] {
    return fetchHeads(this.db, threadId, before, limitPlus1);
  }
  rangeBodies(threadId: string, oldest: number, before: number): RangeBodyRow[] {
    return fetchRangeBodies(this.db, threadId, oldest, before);
  }
  chunksFor(ids: readonly string[]): ChunkRow[] {
    return fetchChunks(this.db, ids);
  }
  tailHeads(threadId: string, rootAgentId: string | undefined, limit: number): unknown[] {
    return fetchTailHeads(this.db, threadId, rootAgentId, limit);
  }
  windowTarget(threadId: string, aroundSeq: number): number | null {
    return fetchTarget(this.db, threadId, aroundSeq);
  }
  windowNeighbors(
    threadId: string,
    targetSeq: number,
    before: number,
    after: number,
  ): { older: number[]; newer: number[] } {
    return fetchNeighborSeqs(this.db, threadId, targetSeq, before, after);
  }
  windowExistence(
    threadId: string,
    first: number,
    last: number,
  ): { hasBefore: boolean; hasAfter: boolean } {
    return fetchExistence(this.db, threadId, first, last);
  }
}
