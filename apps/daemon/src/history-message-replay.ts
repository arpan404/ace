import { z } from "zod";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { ThreadId, ItemId } from "@ace/protocol";
import type { OutputReader, SearchReplayItem } from "@ace/search";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Source = z.tuple([ThreadId, ItemId, count, count]);
const Total = z.object({ bytes: count, missing: count });
const Slice = z.object({ stream: z.string(), bytes: count, boundary: count });
const Bytes = z.instanceof(Uint8Array).refine((bytes) => bytes.length <= 65536);

// The final text part remains a separate append target. All preceding nonempty
// sources form an immutable UTF-16 view, with a newline between part boundaries.
const prefix = `WITH revision AS MATERIALIZED (
  SELECT r.item,r.item_id,h.thread_id,
    CASE WHEN json_extract(r.item,'$.parts[#-1].type')='text'
      THEN json_array_length(r.item,'$.parts')-1 ELSE -1 END AS appendOrdinal
  FROM history_item_revisions r
  JOIN history_items h ON h.id=r.item_id WHERE h.thread_id=? AND r.item_id=? AND r.seq=?
), parts AS (
  SELECT p.key AS ordinal,json_extract(p.value,'$.source.streamId') AS stream,
    r.item_id,r.thread_id
  FROM revision r,json_each(r.item,'$.parts') p
  WHERE json_extract(p.value,'$.type')='text' AND json_type(p.value,'$.source')='object'
    AND p.key<>r.appendOrdinal
), sizes AS (
  SELECT p.ordinal,p.stream,(SELECT v.size FROM history_stream_versions v
    WHERE v.stream_id=p.stream AND v.thread_id=p.thread_id AND v.item_id=p.item_id
    AND v.encoding='utf-16le' AND v.seq<=? ORDER BY v.seq DESC LIMIT 1) AS bytes FROM parts p
)`;

/** A constant-size descriptor whose reads retain only the requested byte range. */
export class HistoryMessageReplay {
  private readonly db: DatabaseSync;
  private readonly readBytes: OutputReader;
  private totalQuery?: StatementSync;
  private rangeQuery?: StatementSync;
  constructor(db: DatabaseSync, readBytes: OutputReader) {
    this.db = db;
    this.readBytes = readBytes;
  }
  segment(
    thread: ThreadId,
    id: ItemId,
    revision: number,
    through: number,
  ): SearchReplayItem["segments"][number] | undefined {
    const query = (this.totalQuery ??= this.db.prepare(`${prefix}
      SELECT COALESCE(sum(CASE WHEN bytes>0 THEN bytes+2 ELSE 0 END),0) AS bytes,
        COALESCE(sum(bytes IS NULL),0) AS missing FROM sizes`));
    const total = Total.parse(query.get(thread, id, revision, through));
    if (total.missing) throw new Error("search_replay_source_unavailable");
    if (!total.bytes) return;
    return {
      name: "message-text",
      category: "messages",
      text: "",
      source: {
        streamId: `history-message:${JSON.stringify([thread, id, revision, through])}`,
        bytes: total.bytes,
        encoding: "utf-16le",
      },
    };
  }
  read(thread: ThreadId, streamId: string, offset: number, limit: number): Buffer | undefined {
    if (!streamId.startsWith("history-message:")) return;
    const [owner, id, revision, through] = Source.parse(JSON.parse(streamId.slice(16)));
    if (owner !== thread) throw new Error("search_replay_source_thread");
    count.parse(offset);
    z.number().int().min(1).max(65536).parse(limit);
    const query = (this.rangeQuery ??= this.db.prepare(`${prefix}, offsets AS (
      SELECT stream,bytes,sum(bytes+2) OVER (ORDER BY ordinal ROWS UNBOUNDED PRECEDING) AS boundary
      FROM sizes WHERE bytes>0
    ) SELECT stream,bytes,boundary FROM offsets WHERE boundary>? AND boundary-bytes-2<? ORDER BY boundary`));
    const output = Buffer.alloc(limit);
    const newline = Buffer.from("\n", "utf16le");
    let written = 0;
    for (const raw of query.iterate(thread, id, revision, through, offset, offset + limit)) {
      const row = Slice.parse(raw);
      const start = row.boundary - row.bytes - 2;
      const from = Math.max(start, offset) - start;
      const to = Math.min(row.boundary, offset + limit) - start;
      const textEnd = Math.min(row.bytes, to);
      if (from < textEnd) {
        const input = this.readBytes(thread, row.stream, from, textEnd - from);
        if (!input || input.length !== textEnd - from)
          throw new Error("search_replay_source_unavailable");
        const bytes = Bytes.parse(input);
        output.set(bytes, written);
        written += bytes.length;
      }
      if (to > row.bytes) {
        const separator = newline.subarray(Math.max(from - row.bytes, 0), to - row.bytes);
        output.set(separator, written);
        written += separator.length;
      }
    }
    return output.subarray(0, written);
  }
}
