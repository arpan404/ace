import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { TextSource, ThreadId, ItemId } from "@ace/protocol";
import {
  SearchReplayItem,
  outputText,
  sourceText,
  appendWindow,
  windowText,
  type OutputReader,
} from "@ace/search";

import { HistoryMessageReplay } from "./history-message-replay.ts";
import { outputStreamId } from "@ace/projection";

interface Streams {
  source(
    thread: ThreadId,
    item: ItemId,
    stream: string,
    through: number,
  ): { bytes: number; encoding: "utf-8" | "utf-16le" } | undefined;
  read: OutputReader;
}
const Source = z.tuple([ThreadId, ItemId, z.number().int().nonnegative(), z.string()]);
const Bytes = z.object({ bytes: z.instanceof(Uint8Array) });
const Total = z.object({ category: z.string(), bytes: z.number().int().nonnegative() });
const Metadata = z.object({
  id: ItemId,
  agentId: z.string(),
  type: z.string(),
  createdAt: z.number(),
  complete: z.number(),
  toolKind: z.string().nullable(),
  title: z.string(),
  outputStream: z.string().nullable(),
  source: z.string().nullable(),
  level: z.string().nullable(),
  appendTarget: z.string().nullable(),
  appendSource: z.string().nullable(),
});

// SQLite visits canonical leaves; raw/native data, source descriptors and attachments
// never enter this view. Large leaf strings are sliced as BLOBs before crossing into JS.
const fields = `WITH revision AS (
  SELECT r.item FROM history_item_revisions r JOIN history_items h ON h.id=r.item_id
  WHERE h.thread_id=? AND r.item_id=? AND r.seq=?
), leaves AS (
  SELECT t.id,t.atom,CASE
    WHEN json_extract(r.item,'$.type')='tool_call' THEN CASE
      WHEN t.fullkey='$.call.error' THEN 'errors'
      WHEN t.fullkey='$.call.title' THEN 'tool_output'
      WHEN t.fullkey IN ('$.call.detail.command','$.call.detail.rawCommand') THEN 'commands'
      WHEN t.fullkey IN ('$.call.detail.cwd','$.call.detail.path') OR t.fullkey LIKE '$.call.detail.changes[%].%' THEN 'files'
      WHEN t.fullkey LIKE '$.call.detail.%' AND t.fullkey NOT LIKE '$.call.detail.output.%' THEN 'tool_output'
    END
    WHEN json_extract(r.item,'$.type')='message' THEN CASE
      WHEN t.fullkey LIKE '$.parts[%].text' AND json_type(r.item,t.path||'.source') IS NULL THEN 'messages'
      WHEN t.fullkey LIKE '$.parts[%].path' THEN 'files'
    END
    WHEN json_extract(r.item,'$.type') IN ('reasoning','notice') AND t.fullkey='$.text' AND json_type(r.item,'$.source') IS NULL THEN json_extract(r.item,'$.type')
    WHEN json_extract(r.item,'$.type')='artifact' AND t.fullkey IN ('$.path','$.mimeType') THEN 'files'
    WHEN json_extract(r.item,'$.type') LIKE 'delegation.%' AND
      (t.fullkey IN ('$.title','$.role','$.outcome.result') OR t.fullkey LIKE '$.results[%].result') THEN 'notices'
  END AS category
  FROM revision r,json_tree(r.item) t WHERE t.atom IS NOT NULL
), fields AS (
  SELECT id,category,CAST(CAST(atom AS BLOB)||X'0A' AS BLOB) AS value FROM leaves WHERE category IS NOT NULL
)`;

/** A bounded search representation for revisions whose non-stream metadata is oversized. */
export class HistorySearchReplay {
  private readonly db: DatabaseSync;
  private readonly streams: Streams;
  private readonly messages: HistoryMessageReplay;
  constructor(db: DatabaseSync, streams: Streams) {
    this.db = db;
    this.streams = streams;
    this.messages = new HistoryMessageReplay(db, streams.read);
  }
  item(thread: ThreadId, id: ItemId, seq: number, through: number): SearchReplayItem {
    const m = Metadata.parse(
      this.db
        .prepare(`SELECT
      json_extract(item,'$.id') AS id,json_extract(item,'$.agentId') AS agentId,
      json_extract(item,'$.type') AS type,json_extract(item,'$.createdAt') AS createdAt,
      json_extract(item,'$.complete') AS complete,json_extract(item,'$.call.detail.kind') AS toolKind,
      COALESCE(substr(json_extract(item,'$.call.title'),1,8192),'') AS title,
      json_extract(item,'$.call.detail.output.streamId') AS outputStream,
      json_extract(item,'$.source') AS source,json_extract(item,'$.level') AS level,
      json_extract(item,'$.parts[#-1].source') AS appendSource,
      CASE json_extract(item,'$.type')
        WHEN 'message' THEN CASE WHEN json_extract(item,'$.parts[#-1].type')='text'
          THEN 'part:' || (json_array_length(item,'$.parts')-1) END
        WHEN 'notice' THEN 'text' WHEN 'reasoning' THEN 'text'
        WHEN 'tool_call' THEN CASE WHEN json_extract(item,'$.call.detail.kind')='shell' THEN 'output' END
      END AS appendTarget
      FROM history_item_revisions WHERE item_id=? AND seq=?`)
        .get(id, seq),
    );
    const totals = this.db
      .prepare(
        `${fields} SELECT category,sum(length(value)) AS bytes FROM fields GROUP BY category`,
      )
      .all(thread, id, seq);
    const segments: SearchReplayItem["segments"] = totals.map((row) => {
      const total = Total.parse(row);
      return {
        name: total.category,
        category: total.category,
        text: "",
        source: {
          streamId: `history-search:${JSON.stringify([thread, id, seq, total.category])}`,
          bytes: total.bytes,
          encoding: "utf-8" as const,
        },
      };
    });
    const addSource = (name: string, category: string, streamId: string) => {
      const version = this.streams.source(thread, id, streamId, through);
      if (version) segments.push({ name, category, text: "", source: { streamId, ...version } });
    };
    if (m.type === "message") {
      const aggregate = this.messages.segment(thread, id, seq, through);
      if (aggregate) segments.push(aggregate);
      if (m.appendTarget && m.appendSource)
        addSource(
          m.appendTarget,
          "messages",
          TextSource.parse(JSON.parse(m.appendSource)).streamId,
        );
    } else if ((m.type === "notice" || m.type === "reasoning") && m.source) {
      addSource(
        "text",
        m.type === "notice" && m.level === "error" ? "errors" : m.type,
        TextSource.parse(JSON.parse(m.source)).streamId,
      );
    } else if (m.toolKind === "shell") {
      // Creation may have no output summary; a later delta still has a durable version.
      addSource("output", "tool_output", m.outputStream ?? outputStreamId(id));
    }
    let window = { head: "", tail: "", size: 0 };
    for (const segment of segments) {
      if (window.size) window = appendWindow(window, "\n");
      const read: OutputReader = (owner, stream, offset, limit) =>
        this.read(owner, stream, offset, limit) ?? this.streams.read(owner, stream, offset, limit);
      const text =
        segment.source.encoding === "utf-16le"
          ? sourceText(read, thread, TextSource.parse(segment.source), segment.text)
          : outputText(read, thread, { ...segment.source, tail: segment.text, truncated: true });
      window = appendWindow(window, text);
    }
    return SearchReplayItem.parse({
      type: "search.item",
      item: {
        id: m.id,
        agentId: m.agentId,
        type: m.type,
        createdAt: m.createdAt,
        complete: Boolean(m.complete),
        ...(m.toolKind ? { toolKind: m.toolKind } : {}),
      },
      title: m.title,
      body: windowText(window),
      appendTarget: m.appendTarget,
      segments,
    });
  }
  read(thread: ThreadId, streamId: string, offset: number, limit: number): Buffer | undefined {
    const message = this.messages.read(thread, streamId, offset, limit);
    if (message !== undefined) return message;
    if (!streamId.startsWith("history-search:")) return;
    const [owner, id, seq, category] = Source.parse(JSON.parse(streamId.slice(15)));
    if (owner !== thread) throw new Error("search_replay_source_thread");
    z.number().int().nonnegative().parse(offset);
    z.number().int().min(1).max(65536).parse(limit);
    const rows = this.db
      .prepare(`${fields}, offsets AS (
      SELECT value,sum(length(value)) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) AS boundary
      FROM fields WHERE category=?
    ) SELECT substr(value,max(1,?-boundary+length(value)+1),min(boundary,?)-max(boundary-length(value),?)) AS bytes
      FROM offsets WHERE boundary>? AND boundary-length(value)<?`)
      .all(thread, id, seq, category, offset, offset + limit, offset, offset, offset + limit);
    return Buffer.concat(rows.map((row) => Buffer.from(Bytes.parse(row).bytes)));
  }
}
