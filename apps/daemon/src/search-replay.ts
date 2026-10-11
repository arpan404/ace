import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { Event, ItemId, ThreadId } from "@ace/protocol";
import { SearchReplayEvent, type SearchPage } from "@ace/search";
import type { HistoryIndex } from "./history-index.ts";

const Options = z.object({
  afterSeq: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(256),
  maxBytes: z
    .number()
    .int()
    .min(1024)
    .max(512 * 1024),
});
const Row = z.object({
  seq: z.number(),
  id: z.string(),
  thread_id: ThreadId,
  at: z.number(),
  type: z.string(),
  bytes: z.number(),
});
const ItemKey = z.object({ id: ItemId });

/** Inspect source lengths before retrieving JSON. One oversized row owns a whole work page. */
export class SearchReplay {
  private readonly sizes;
  private readonly payload;
  private readonly itemKey;
  private readonly threadPayload;
  private readonly history: HistoryIndex;
  constructor(db: DatabaseSync, history: HistoryIndex) {
    this.history = history;
    this.sizes = db.prepare(
      "SELECT seq,id,thread_id,at,type,length(CAST(payload AS BLOB)) AS bytes FROM events WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?",
    );
    this.payload = db.prepare("SELECT payload FROM events WHERE seq=?");
    this.threadPayload = db.prepare(`SELECT json_extract(payload,'$.thread.id') AS id,
      json_extract(payload,'$.thread.workspaceId') AS workspaceId,
      json_extract(payload,'$.thread.provider') AS provider,
      json_extract(payload,'$.thread.createdAt') AS createdAt,
      json_extract(payload,'$.thread.updatedAt') AS updatedAt,
      COALESCE(json_extract(payload,'$.thread.status'),json_extract(payload,'$.status')) AS status,
      substr(COALESCE(json_extract(payload,'$.thread.title'),json_extract(payload,'$.title')),1,8192) ||
      CASE WHEN length(COALESCE(json_extract(payload,'$.thread.title'),json_extract(payload,'$.title'))) > 16384 THEN
        '\n[… omitted …]\n' || substr(COALESCE(json_extract(payload,'$.thread.title'),json_extract(payload,'$.title')),-8192)
      ELSE substr(COALESCE(json_extract(payload,'$.thread.title'),json_extract(payload,'$.title')),8193) END AS title
      FROM events WHERE seq=?`);
    this.itemKey = db.prepare(
      "SELECT COALESCE(json_extract(payload,'$.item.id'),json_extract(payload,'$.itemId')) AS id FROM events WHERE seq=?",
    );
  }
  read(input: unknown, headSeq: number): SearchPage {
    const q = Options.parse(input);
    const events: SearchPage["events"] = [];
    let bytes = 2;
    let work = 0;
    let throughSeq = q.afterSeq;
    let complete = true;
    let rowsRead = 0;
    const rows = this.sizes.iterate(q.afterSeq, headSeq, q.limit + 1);
    for (const raw of rows) {
      const row = Row.parse(raw);
      if (rowsRead++ === q.limit || (work && work + row.bytes > q.maxBytes)) {
        complete = false;
        break;
      }
      // Only the canonical fields used by search cross this boundary. Other event types
      // still advance coverage, including retained gaps and raw provider evidence.
      if (
        ![
          "thread.created",
          "thread.updated",
          "item.created",
          "item.updated",
          "item.delta",
          "item.deleted",
        ].includes(row.type)
      ) {
        throughSeq = row.seq;
        work += Math.min(row.bytes, q.maxBytes);
        if (work >= q.maxBytes) {
          complete = false;
          break;
        }
        continue;
      }
      const envelope = { seq: row.seq, id: row.id, threadId: row.thread_id, at: row.at };
      const overhead = Buffer.byteLength(JSON.stringify({ ...envelope, payload: null })) - 4 + 1;
      const capacity = q.maxBytes - bytes - overhead;
      const oversized = row.bytes > q.maxBytes - 2 - overhead;
      if (!oversized && row.bytes > capacity) {
        complete = false;
        break;
      }
      let payload: unknown;
      if (oversized && ["item.created", "item.updated", "item.delta"].includes(row.type)) {
        const key = ItemKey.parse(this.itemKey.get(row.seq));
        const item = this.history.searchItem(
          row.thread_id,
          key.id,
          row.seq,
          capacity - (Buffer.byteLength(JSON.stringify({ type: "item.updated", item: null })) - 4),
        );
        if (!item) throw new Error("search_replay_source_unavailable");
        payload = item.type === "search.item" ? item : { type: "item.updated", item };
      } else if (oversized && (row.type === "thread.created" || row.type === "thread.updated")) {
        const bounded = z
          .object({
            id: z.string().nullable(),
            workspaceId: z.string().nullable(),
            provider: z.string().nullable(),
            createdAt: z.number().nullable(),
            updatedAt: z.number().nullable(),
            status: z.string().nullable(),
            title: z.string().nullable(),
          })
          .parse(this.threadPayload.get(row.seq));
        const status: unknown = bounded.status ? JSON.parse(bounded.status) : undefined;
        payload =
          row.type === "thread.created"
            ? { type: "thread.created", thread: { ...bounded, status } }
            : {
                type: "thread.updated",
                ...(bounded.title === null ? {} : { title: bounded.title }),
                ...(status === undefined ? {} : { status }),
              };
      } else {
        if (oversized) throw new Error("search_replay_identity_limit");
        payload = JSON.parse(String(this.payload.get(row.seq)?.payload));
      }
      const event = (
        typeof payload === "object" &&
        payload !== null &&
        "type" in payload &&
        payload.type === "search.item"
          ? SearchReplayEvent
          : Event
      ).parse({
        seq: row.seq,
        id: row.id,
        threadId: row.thread_id,
        at: row.at,
        payload,
      });
      const size = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (bytes + size > q.maxBytes) throw new Error("search_replay_page_limit");
      events.push(event);
      bytes += size;
      throughSeq = row.seq;
      work += row.bytes;
      if (work >= q.maxBytes) {
        complete = false;
        break;
      }
    }
    // A count/byte stop is never evidence that the source is exhausted.
    if (complete) throughSeq = headSeq;
    return { events, bytes, throughSeq };
  }
}
