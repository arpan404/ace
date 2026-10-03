import { z } from "zod";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { Event, Item, ItemId, ThreadId, type TextSource, type ItemsPage } from "@ace/protocol";
import { outputStreamId, summarizeOutput, utf8Tail } from "@ace/projection";
import { ItemTextStore } from "./item-text-store.ts";
import { appendTextSource } from "./text-preview.ts";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Stream = z.object({ id: z.string(), size: count });
const Version = z.object({
  stream_id: z.string(),
  thread_id: ThreadId,
  item_id: ItemId,
  seq: count,
  size: count,
  encoding: z.enum(["utf-16le", "utf-8"]),
});
type ReadBytes = (
  stream: string,
  offset: number,
  limit: number,
) => { bytes: Buffer; nextOffset: number; eof: boolean };
type ArchiveOutput = (
  threadId: ThreadId,
  itemId: ItemId,
  stream: string,
  offset: number,
  text: string,
) => void;

/** Immutable metadata and stream lengths. Deltas write one small indexed row. */
export class HistoryIndex {
  private db: DatabaseSync;
  private statement: (sql: string) => StatementSync;
  private texts: ItemTextStore;
  private readBytes: ReadBytes;
  private archiveOutput: ArchiveOutput;
  constructor(
    db: DatabaseSync,
    statement: (sql: string) => StatementSync,
    readBytes: ReadBytes,
    archiveOutput: ArchiveOutput,
  ) {
    this.db = db;
    this.statement = statement;
    this.readBytes = readBytes;
    this.archiveOutput = archiveOutput;
    this.texts = new ItemTextStore(db);
    db.exec(`CREATE TABLE IF NOT EXISTS history_inventory (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, total INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history_items (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      created_seq INTEGER NOT NULL, ordinal INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS history_items_creation ON history_items(thread_id,created_seq);
    CREATE TABLE IF NOT EXISTS history_item_revisions (
      item_id TEXT NOT NULL REFERENCES history_items(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, item JSON NOT NULL, PRIMARY KEY(item_id,seq)
    );
    CREATE INDEX IF NOT EXISTS history_completed_revisions ON history_item_revisions(item_id,seq)
      WHERE json_extract(item,'$.complete')=1;
    CREATE TABLE IF NOT EXISTS history_stream_versions (
      stream_id TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL, seq INTEGER NOT NULL, size INTEGER NOT NULL,
      encoding TEXT NOT NULL, PRIMARY KEY(stream_id,seq)
    );
    CREATE TABLE IF NOT EXISTS history_index_migration (id INTEGER PRIMARY KEY);`);
  }
  initialize(): void {
    if (this.statement("SELECT id FROM history_index_migration WHERE id=1").get()) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Stream the log once at startup. Previous streams can be recovered after a live replacement.
      for (const row of this.statement("SELECT * FROM events ORDER BY seq").iterate()) {
        const event = Event.parse({
          seq: row.seq,
          id: row.id,
          threadId: row.thread_id,
          at: row.at,
          payload: JSON.parse(String(row.payload)),
        });
        this.replay(event);
      }
      this.db.exec("INSERT INTO history_index_migration VALUES (1); COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private revision(event: Event, item: Item): void {
    if (!this.statement("SELECT id FROM history_items WHERE id=?").get(item.id)) {
      const row = this.statement(`INSERT INTO history_inventory VALUES (?,1)
        ON CONFLICT(thread_id) DO UPDATE SET total=total+1 RETURNING total`).get(event.threadId);
      this.statement("INSERT INTO history_items VALUES (?,?,?,?)").run(
        item.id,
        event.threadId,
        event.seq,
        count.parse(row?.total),
      );
    }
    this.statement("INSERT INTO history_item_revisions VALUES (?,?,?)").run(
      item.id,
      event.seq,
      JSON.stringify(item),
    );
  }
  private version(
    event: Event,
    item: Item,
    streamId: string,
    size: number,
    encoding: "utf-16le" | "utf-8",
  ): void {
    this.statement("INSERT OR REPLACE INTO history_stream_versions VALUES (?,?,?,?,?,?)").run(
      streamId,
      event.threadId,
      item.id,
      event.seq,
      size,
      encoding,
    );
  }
  private latest(streamId: string, through: number) {
    const row = this.statement(
      "SELECT * FROM history_stream_versions WHERE stream_id=? AND seq<=? ORDER BY seq DESC LIMIT 1",
    ).get(streamId, through);
    return row ? Version.parse(row) : undefined;
  }
  private itemAt(id: string, through: number): Item | undefined {
    const row = this.statement(
      "SELECT item FROM history_item_revisions WHERE item_id=? AND seq<=? ORDER BY seq DESC LIMIT 1",
    ).get(id, through);
    return row ? Item.parse(JSON.parse(String(row.item))) : undefined;
  }
  private sources(event: Event, item: Item): void {
    const sources: TextSource[] = [];
    if (item.type === "message")
      for (const part of item.parts) {
        if (part.type === "text" && part.source) sources.push(part.source);
      }
    else if ((item.type === "notice" || item.type === "reasoning") && item.source)
      sources.push(item.source);
    for (const source of sources)
      this.version(event, item, source.streamId, source.bytes, "utf-16le");
    if (item.type === "tool_call" && item.call.detail.kind === "shell" && item.call.detail.output)
      this.version(
        event,
        item,
        item.call.detail.output.streamId,
        item.call.detail.output.bytes,
        "utf-8",
      );
  }
  /** Called after live payload persistence, in the same event transaction. */
  record(event: Event): void {
    const p = event.payload;
    if (p.type === "item.created" || p.type === "item.updated") {
      const row = this.statement("SELECT item FROM item_previews WHERE id=?").get(p.item.id);
      const item = Item.parse(JSON.parse(String(row?.item)));
      this.revision(event, item);
      this.sources(event, item);
    } else if (p.type === "item.delta") {
      const row =
        p.field === "output"
          ? this.statement(
              "SELECT id, size FROM output_streams WHERE item_id=? AND thread_id=?",
            ).get(p.itemId, event.threadId)
          : this.statement(
              "SELECT s.id,s.size FROM item_text_targets t JOIN item_text_streams s ON s.id=t.stream_id WHERE t.item_id=? AND s.thread_id=?",
            ).get(p.itemId, event.threadId);
      if (!row) return;
      const stream = Stream.parse(row);
      // A message ending in an attachment acquires a new append target on its first delta.
      if (p.field !== "output" && !this.latest(stream.id, event.seq)) {
        const preview = this.statement("SELECT item FROM item_previews WHERE id=?").get(p.itemId);
        this.revision(event, Item.parse(JSON.parse(String(preview?.item))));
      }
      this.statement("INSERT INTO history_stream_versions VALUES (?,?,?,?,?,?)").run(
        stream.id,
        event.threadId,
        p.itemId,
        event.seq,
        stream.size,
        p.field === "output" ? "utf-8" : "utf-16le",
      );
    }
  }
  private replay(event: Event): void {
    const p = event.payload;
    if (p.type === "item.created" || p.type === "item.updated") {
      // Legacy preview migration could reuse the creation ID for a later body.
      // Archive tokens keep that live cache from supplying a historical prefix.
      const item = this.texts.revision(p.item, `history:${event.seq}`, event.threadId).item;
      this.revision(event, item);
      this.sources(event, item);
    } else if (p.type === "item.delta") {
      const item = this.itemAt(p.itemId, event.seq);
      if (!item) return;
      if (p.field === "output") {
        if (item.type !== "tool_call" || item.call.detail.kind !== "shell") return;
        const streamId = item.call.detail.output?.streamId ?? outputStreamId(item.id);
        const offset = this.latest(streamId, event.seq)?.size ?? 0;
        this.archiveOutput(event.threadId, item.id, streamId, offset, p.append);
        const size = offset + Buffer.byteLength(p.append);
        this.version(event, item, streamId, size, "utf-8");
      } else {
        let source = appendTextSource(item);
        if (!source && item.type === "message" && p.field === "text") {
          source = this.texts.source(
            item,
            item.parts.length,
            "",
            `history:${event.seq}`,
            event.threadId,
          );
          item.parts.push({ type: "text", text: "", source });
          this.revision(event, item);
        }
        if (!source) return;
        const offset = this.latest(source.streamId, event.seq)?.size ?? source.bytes;
        this.texts.archiveAppend(source, offset, p.append);
        this.version(event, item, source.streamId, offset + p.append.length * 2, "utf-16le");
      }
    }
  }
  count(threadId: ThreadId, through: number): number {
    count.parse(through);
    const row = this.statement(
      "SELECT ordinal FROM history_items WHERE thread_id=? AND created_seq<=? ORDER BY created_seq DESC LIMIT 1",
    ).get(threadId, through);
    return row ? count.parse(row.ordinal) : 0;
  }
  completion(threadId: ThreadId, itemId: ItemId): { throughSeq: number; item: Item } {
    const row =
      this.statement(`SELECT r.seq,r.item FROM history_item_revisions r JOIN history_items h ON h.id=r.item_id
      WHERE h.thread_id=? AND h.id=? AND json_extract(r.item,'$.complete')=1 ORDER BY r.seq LIMIT 1`).get(
        threadId,
        itemId,
      );
    if (!row) throw new Error("Item completion boundary is unavailable");
    return { throughSeq: count.parse(row.seq), item: Item.parse(JSON.parse(String(row.item))) };
  }
  stream(threadId: ThreadId, streamId: string, through: number) {
    const version = this.latest(streamId, through);
    if (!version || version.thread_id !== threadId)
      throw new Error("Stream is outside historical scope");
    return version;
  }
  readStream(threadId: ThreadId, streamId: string, through: number, offset: number, limit: number) {
    count.parse(through);
    count.parse(offset);
    z.number()
      .int()
      .min(1)
      .max(256 * 1024)
      .parse(limit);
    const version = this.stream(threadId, streamId, through);
    const remaining = Math.max(0, version.size - offset);
    if (!remaining)
      return { bytes: Buffer.alloc(0), nextOffset: offset, eof: true, encoding: version.encoding };
    const result = this.readBytes(streamId, offset, Math.min(limit, remaining));
    if (result.bytes.length !== Math.min(limit, remaining))
      throw new Error("Historical stream prefix is unavailable");
    return { ...result, eof: result.nextOffset >= version.size, encoding: version.encoding };
  }
  private preview(threadId: ThreadId, item: Item, through: number): Item {
    let units = 4096;
    const text = (source: TextSource) => {
      const version = this.stream(threadId, source.streamId, through);
      source.bytes = version.size;
      const length = Math.min(units * 2, source.bytes);
      const value = length
        ? this.readStream(threadId, source.streamId, through, 0, length).bytes.toString("utf16le")
        : "";
      units -= value.length;
      return value;
    };
    if (item.type === "message")
      for (const part of item.parts) {
        if (part.type === "text" && part.source) part.text = text(part.source);
      }
    else if ((item.type === "reasoning" || item.type === "notice") && item.source)
      item.text = text(item.source);
    if (item.type === "tool_call" && item.call.detail.kind === "shell") {
      const streamId = item.call.detail.output?.streamId ?? outputStreamId(item.id);
      const version = this.latest(streamId, through);
      if (version?.size) {
        const start = Math.max(0, version.size - 4096);
        const tail = utf8Tail(
          this.readStream(threadId, streamId, through, start, version.size - start).bytes,
          4096,
        );
        const summary = summarizeOutput(item.id, tail);
        item.call.detail.output = {
          ...summary,
          streamId,
          bytes: version.size,
          truncated: start > 0 || summary.truncated,
        };
      }
    }
    return item;
  }
  page(
    threadId: ThreadId,
    through: number,
    before: number,
    limit: number,
    byteLimit: number,
  ): Omit<ItemsPage, "seq"> {
    count.parse(through);
    count.parse(before);
    z.number().int().min(1).max(200).parse(limit);
    z.number()
      .int()
      .min(512)
      .max(1024 * 1024)
      .parse(byteLimit);
    const rows = z
      .array(z.object({ id: ItemId, created_seq: count }))
      .max(201)
      .parse(
        this.statement(
          "SELECT id,created_seq FROM history_items WHERE thread_id=? AND created_seq<=? AND created_seq<? ORDER BY created_seq DESC LIMIT ?",
        ).all(threadId, through, before, limit + 1),
      );
    const items: Item[] = [],
      cursors: [string, number][] = [];
    let bytes = 512;
    for (const row of rows.slice(0, limit)) {
      const value = this.itemAt(row.id, through);
      if (!value) throw new Error("Historical revision is unavailable");
      const item = this.preview(threadId, value, through);
      const size =
        Buffer.byteLength(JSON.stringify(item)) + Buffer.byteLength(JSON.stringify(row.id)) + 64;
      if (bytes + size > byteLimit) {
        if (!items.length) throw new Error("Historical item exceeds page capacity");
        break;
      }
      bytes += size;
      items.push(item);
      cursors.push([row.id, row.created_seq]);
    }
    items.reverse();
    return {
      threadId,
      items,
      itemSeqs: Object.fromEntries(cursors),
      itemsBefore: rows.length > items.length ? (cursors.at(-1)?.[1] ?? before) : null,
    };
  }
}
