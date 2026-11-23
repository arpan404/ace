import { nativeHandle } from "@ace/provider-kit/sqlite";
import type { DatabaseSync } from "node:sqlite";

/**
 * Phase 1b's native item fetches (docs/store/porting-guide.md): Rust runs the batched
 * statements on the store's own connection and returns the raw column values exactly as
 * stored. TypeScript keeps every shaping step after the fetch.
 */
interface ItemsFetchBinding {
  itemsFetchHeads(threadId: string, before: number, limit: number): string;
  itemsFetchHeadsBySeqs(threadId: string, seqsJson: string): string;
  itemsFetchBodies(idsJson: string): string;
  itemsFetchPreviews(idsJson: string): string;
  itemsFetchRangeBodies(threadId: string, oldest: number, before: number): string;
  itemsFetchChunks(idsJson: string): string;
  itemsFetchTailHeads(threadId: string, rootAgentId: string | undefined, limit: number): string;
  itemsFetchStreamSizes(streamIdsJson: string): string;
  itemsFetchStreamBytes(rangesJson: string): string;
  itemsFetchTarget(threadId: string, aroundSeq: number): string;
  itemsFetchNeighborSeqs(
    threadId: string,
    targetSeq: number,
    before: number,
    after: number,
  ): string;
  itemsFetchExistence(threadId: string, first: number, last: number): string;
}

function binding(db: DatabaseSync): ItemsFetchBinding {
  const handle = nativeHandle(db) as Partial<ItemsFetchBinding> | undefined;
  if (!handle || typeof handle.itemsFetchHeads !== "function")
    throw new Error("Native item fetches need the phase 1b store addon");
  return handle as ItemsFetchBinding;
}

export interface HeadRow {
  id: string;
  created_seq: number;
  size: number;
  item_type: string;
}

export interface BodyRow {
  id: string;
  kind: number;
  item: string | null;
  created_seq: number | null;
  seq: number | null;
  field: string | null;
  append: string | null;
}

export interface PreviewRow {
  id: string;
  item: string;
  target: number;
  created_seq: number | null;
}

export interface RangeBodyRow {
  id: string;
  item: string;
  created_seq: number;
}

export interface ChunkRow {
  item_id: string;
  seq: number;
  field: string;
  append: string;
}

export interface TailHeadRow {
  id: string;
  created_seq: number;
  size: number;
  agent_id: string;
}

export interface StreamSizeRow {
  id: string;
  size: number;
}

export interface StreamByteRow {
  stream_id: string;
  offset: number;
  bytes: Uint8Array;
}

function parse<T>(text: string): T {
  return JSON.parse(text) as T;
}

export function fetchHeads(
  db: DatabaseSync,
  threadId: string,
  before: number,
  limit: number,
): HeadRow[] {
  return parse<HeadRow[]>(binding(db).itemsFetchHeads(threadId, before, limit));
}

export function fetchHeadsBySeqs(db: DatabaseSync, threadId: string, seqs: number[]): HeadRow[] {
  return parse<HeadRow[]>(binding(db).itemsFetchHeadsBySeqs(threadId, JSON.stringify(seqs)));
}

export function fetchBodies(db: DatabaseSync, ids: readonly string[]): BodyRow[] {
  if (!ids.length) return [];
  return parse<BodyRow[]>(binding(db).itemsFetchBodies(JSON.stringify(ids)));
}

export function fetchPreviews(db: DatabaseSync, ids: readonly string[]): PreviewRow[] {
  if (!ids.length) return [];
  return parse<PreviewRow[]>(binding(db).itemsFetchPreviews(JSON.stringify(ids)));
}

export function fetchRangeBodies(
  db: DatabaseSync,
  threadId: string,
  oldest: number,
  before: number,
): RangeBodyRow[] {
  return parse<RangeBodyRow[]>(binding(db).itemsFetchRangeBodies(threadId, oldest, before));
}

export function fetchChunks(db: DatabaseSync, ids: readonly string[]): ChunkRow[] {
  if (!ids.length) return [];
  return parse<ChunkRow[]>(binding(db).itemsFetchChunks(JSON.stringify(ids)));
}

export function fetchTailHeads(
  db: DatabaseSync,
  threadId: string,
  rootAgentId: string | undefined,
  limit: number,
): TailHeadRow[] {
  return parse<TailHeadRow[]>(binding(db).itemsFetchTailHeads(threadId, rootAgentId, limit));
}

export function fetchStreamSizes(db: DatabaseSync, streamIds: readonly string[]): StreamSizeRow[] {
  if (!streamIds.length) return [];
  return parse<StreamSizeRow[]>(binding(db).itemsFetchStreamSizes(JSON.stringify(streamIds)));
}

export function fetchStreamBytes(
  db: DatabaseSync,
  ranges: readonly { id: string; start: number; end: number }[],
): StreamByteRow[] {
  if (!ranges.length) return [];
  const rows = parse<{ stream_id: string; offset: number; bytes: string }[]>(
    binding(db).itemsFetchStreamBytes(JSON.stringify(ranges)),
  );
  return rows.map((row) => ({
    stream_id: row.stream_id,
    offset: row.offset,
    bytes: Buffer.from(row.bytes, "base64"),
  }));
}

export function fetchTarget(db: DatabaseSync, threadId: string, aroundSeq: number): number | null {
  const parsed = parse<{ targetSeq: number | null }>(
    binding(db).itemsFetchTarget(threadId, aroundSeq),
  );
  return parsed.targetSeq;
}

export function fetchNeighborSeqs(
  db: DatabaseSync,
  threadId: string,
  targetSeq: number,
  before: number,
  after: number,
): { older: number[]; newer: number[] } {
  return parse<{ older: number[]; newer: number[] }>(
    binding(db).itemsFetchNeighborSeqs(threadId, targetSeq, before, after),
  );
}

export function fetchExistence(
  db: DatabaseSync,
  threadId: string,
  first: number,
  last: number,
): { hasBefore: boolean; hasAfter: boolean } {
  return parse<{ hasBefore: boolean; hasAfter: boolean }>(
    binding(db).itemsFetchExistence(threadId, first, last),
  );
}

/** Group UNION body+chunk rows by id, as `materializeAll` groups its statement's rows. */
export function groupBodyRows(rows: BodyRow[]): {
  bodies: Map<string, { item: string; created_seq: number }>;
  chunks: Map<string, { seq: number; field: string; append: string }[]>;
} {
  const bodies = new Map<string, { item: string; created_seq: number }>();
  const chunks = new Map<string, { seq: number; field: string; append: string }[]>();
  for (const row of rows) {
    if (row.kind === 0) {
      if (row.item !== null && row.created_seq !== null)
        bodies.set(row.id, { item: row.item, created_seq: row.created_seq });
    } else {
      if (row.seq !== null && row.field !== null && row.append !== null) {
        const list = chunks.get(row.id);
        const entry = { seq: row.seq, field: row.field, append: row.append };
        if (list) list.push(entry);
        else chunks.set(row.id, [entry]);
      }
    }
  }
  return { bodies, chunks };
}
