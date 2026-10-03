import { StreamingBlobs } from "./streaming-blobs.ts";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  Event,
  Item,
  EventPayload,
  type RawPayload,
  ThreadId,
  AgentId,
  ItemId,
  ToolCall,
} from "@ace/protocol";
import { ItemStore } from "./item-store.ts";
import { applyDelta, outputStreamId, summarizeOutput, utf8Slice } from "@ace/projection";

// Only the retired shell fields differ from the current protocol. All other
// fields pass through unchanged and are validated by Event after conversion.
const LegacyShellPayload = z.object({
  type: z.enum(["item.created", "item.updated"]),
  item: z
    .object({
      id: ItemId,
      agentId: AgentId,
      type: z.literal("tool_call"),
      call: ToolCall.extend({
        detail: z
          .object({
            kind: z.literal("shell"),
            output: z.string(),
            outputTruncated: z.boolean().optional(),
          })
          .loose(),
      }),
    })
    .loose(),
});

/** Event writes run inside Store's transaction. Startup conversion owns its transaction. */
export class PayloadStore {
  readonly streamed: StreamingBlobs;
  private readonly db: DatabaseSync;
  private readonly reads = new Map<string, StatementSync>();
  private outputInsert: StatementSync | undefined;
  private readonly items: ItemStore;
  private readonly nextBlobId: () => string;
  private readonly statement: (sql: string) => StatementSync;
  constructor(
    db: DatabaseSync,
    nextBlobId: () => string,
    statement: (sql: string) => StatementSync,
  ) {
    this.statement = statement;
    this.streamed = new StreamingBlobs(statement);
    this.db = db;
    this.items = new ItemStore(db, statement);
    this.nextBlobId = nextBlobId;
  }
  /** Upgrade existing event logs once, preserving event ids and host sequences. */
  initialize(): void {
    this.items.initialize();
    this.items.initializePreviews();
    if (this.statement("SELECT id FROM payload_migration WHERE id = 1").get()) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of this.statement("SELECT * FROM events ORDER BY seq").iterate()) {
        const input: unknown = JSON.parse(String(row.payload));
        const parsed = EventPayload.safeParse(input);
        const threadId = ThreadId.parse(row.thread_id);
        let payload: EventPayload;
        if (parsed.success) payload = parsed.data;
        else {
          const legacy = LegacyShellPayload.parse(input);
          const { output, outputTruncated: _hint, ...detail } = legacy.item.call.detail;
          const item = Item.parse({
            ...legacy.item,
            call: {
              ...legacy.item.call,
              detail: { ...detail, output: summarizeOutput(legacy.item.id, output) },
            },
          });
          payload = { type: legacy.type, item };
          const streamId = outputStreamId(item.id);
          this.statement(
            "INSERT INTO output_streams (id, thread_id, item_id) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
          ).run(streamId, threadId, item.id);
          const size = Number(
            this.statement("SELECT size FROM output_streams WHERE id = ?").get(streamId)?.size,
          );
          const bytes = Buffer.from(output).subarray(size);
          for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
            this.statement("INSERT INTO output_chunks VALUES (?, ?, ?)").run(
              streamId,
              size + offset,
              bytes.subarray(offset, offset + 64 * 1024),
            );
          }
          if (bytes.length) {
            this.statement("UPDATE output_streams SET size = size + ? WHERE id = ?").run(
              bytes.length,
              streamId,
            );
          }
        }
        const event = Event.parse({
          seq: row.seq,
          id: row.id,
          threadId,
          at: row.at,
          payload: this.cap(payload, threadId),
        });
        this.persist(event);
        this.statement("UPDATE events SET payload = ? WHERE seq = ?").run(
          JSON.stringify(event.payload),
          event.seq,
        );
      }
      this.db.exec("INSERT INTO payload_migration VALUES (1); COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  capRaw(raw: RawPayload[], threadId: ThreadId): RawPayload[] {
    return raw.map((value) => {
      if (!("data" in value)) return value;
      const serialized = JSON.stringify(value.data);
      if (serialized === undefined) return value;
      const bytes = Buffer.from(serialized);
      if (bytes.length <= 64 * 1024) return value;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const existing = this.statement(
        "SELECT id FROM blobs WHERE thread_id = ? AND sha256 = ?",
      ).get(threadId, sha256);
      const id = String(existing?.id ?? this.nextBlobId());
      if (!existing)
        this.statement("INSERT INTO blobs VALUES (?, ?, ?, ?)").run(id, sha256, bytes, threadId);
      return {
        type: value.type,
        ...(value.name === undefined ? {} : { name: value.name }),
        blobRef: id,
        size: bytes.length,
        preview: utf8Slice(serialized, 2048),
      };
    });
  }
  cap(payload: EventPayload, threadId: ThreadId): EventPayload {
    const copy = structuredClone(payload);
    if (copy.type === "item.created" || copy.type === "item.updated") {
      if (copy.item.type === "tool_call")
        copy.item.call.raw = this.capRaw(copy.item.call.raw, threadId);
      else if ("raw" in copy.item) copy.item.raw = this.capRaw(copy.item.raw, threadId);
    } else if (copy.type === "interaction.opened")
      copy.interaction.raw = this.capRaw(copy.interaction.raw, threadId);
    else if (copy.type === "background_task.started")
      copy.task.raw = this.capRaw(copy.task.raw, threadId);
    return copy;
  }
  persist(event: Event): void {
    const p = event.payload;
    if (p.type === "item.deleted") {
      this.db
        .prepare("DELETE FROM items WHERE id = ? AND thread_id = ?")
        .run(p.itemId, event.threadId);
      // Historical handoffs retain output revisions until the thread is deleted.
    } else if (p.type === "item.created" || p.type === "item.updated") {
      this.items.upsert(event, p.item);
    } else if (p.type === "item.delta") {
      if (p.field !== "output") {
        this.items.append(event, p);
        return;
      }
      const row = this.statement("SELECT item FROM items WHERE id = ? AND thread_id = ?").get(
        p.itemId,
        event.threadId,
      );
      if (!row) {
        if (p.field === "output") throw new Error("Output needs a shell item");
        return;
      }
      const item = Item.parse(JSON.parse(String(row.item)));
      if (p.field === "output" && item.type === "tool_call" && item.call.detail.kind === "shell") {
        const streamId = item.call.detail.output?.streamId ?? outputStreamId(item.id);
        this.statement(
          "INSERT INTO output_streams (id, thread_id, item_id) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
        ).run(streamId, event.threadId, item.id);
        const stream = this.statement("SELECT * FROM output_streams WHERE id = ?").get(streamId);
        if (stream?.thread_id !== event.threadId || stream.item_id !== item.id)
          throw new Error("Stream outside item scope");
        const bytes = this.writeOutput(streamId, Number(stream.size), p.append);
        this.statement("UPDATE output_streams SET size = size + ? WHERE id = ?").run(
          bytes,
          streamId,
        );
      }
      if (!applyDelta(item, p.field, p.append)) return;
      const body = JSON.stringify(item);
      this.statement("UPDATE items SET item = ? WHERE id = ?").run(body, item.id);
      this.statement("UPDATE item_heads SET size = ? WHERE id = ?").run(
        Buffer.byteLength(body),
        item.id,
      );
    }
  }
  private writeOutput(streamId: string, offset: number, text: string): number {
    const insert = (this.outputInsert ??= this.statement(
      "INSERT OR IGNORE INTO output_chunks VALUES (?, ?, ?)",
    ));
    const initial = offset;
    for (let start = 0; start < text.length;) {
      let end = Math.min(text.length, start + 16384);
      const high = text.charCodeAt(end - 1);
      const low = text.charCodeAt(end);
      if (end < text.length && high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff)
        end--;
      // At most 64 KiB, with no full-append Buffer allocation or split code point.
      const bytes = Buffer.from(text.slice(start, end));
      insert.run(streamId, offset, bytes);
      offset += bytes.length;
      start = end;
    }
    return offset - initial;
  }
  /** Startup replay restores retired streams without replacing their existing prefix. */
  archiveOutput(
    threadId: ThreadId,
    itemId: ItemId,
    streamId: string,
    offset: number,
    text: string,
  ): void {
    this.statement(
      "INSERT INTO output_streams (id,thread_id,item_id) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING",
    ).run(streamId, threadId, itemId);
    const row = this.statement("SELECT thread_id,item_id FROM output_streams WHERE id=?").get(
      streamId,
    );
    const owner = z.object({ thread_id: ThreadId, item_id: ItemId }).parse(row);
    if (owner.thread_id !== threadId || owner.item_id !== itemId)
      throw new Error("Stream outside item scope");
    const bytes = this.writeOutput(streamId, offset, text);
    this.statement("UPDATE output_streams SET size=MAX(size,?) WHERE id=?").run(
      offset + bytes,
      streamId,
    );
  }
  streamThread(streamId: string): ThreadId | undefined {
    const row = this.statement(
      "SELECT thread_id FROM output_streams WHERE id = ? UNION ALL SELECT thread_id FROM item_text_streams WHERE id = ? LIMIT 1",
    ).get(streamId, streamId);
    return row ? ThreadId.parse(row.thread_id) : undefined;
  }
  private readStatement(sql: string): StatementSync {
    let statement = this.reads.get(sql);
    if (!statement) {
      statement = this.statement(sql);
      this.reads.set(sql, statement);
    }
    return statement;
  }
  blobInfo(blobRef: string) {
    const metadata = this.readStatement(
      "SELECT rowid, thread_id AS threadId, length(bytes) AS size, sha256 FROM blobs WHERE id=?",
    );
    const row = metadata.get(blobRef);
    if (!row) {
      const streamed = this.streamed.info(blobRef);
      if (!streamed) throw new Error("Unknown blob reference");
      return streamed;
    }
    return z
      .object({
        rowid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        threadId: ThreadId,
        size: z.number().int().nonnegative().max(2147483647),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(row);
  }
  outputInfo(streamId: string) {
    const metadata = this.readStatement(
      "SELECT thread_id AS threadId, size FROM output_streams WHERE id=?",
    );
    const row = metadata.get(streamId);
    if (!row) throw new Error("Unknown output stream");
    return z
      .object({
        threadId: ThreadId,
        size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .parse(row);
  }
  readOutput(streamId: string, offset: number, limit: number) {
    const result = this.readLiveOutputBytes(streamId, offset, limit);
    return { ...result, bytes: result.bytes.toString("base64") };
  }
  /** Retired bytes are readable only through a cutoff-authorized historical read. */
  readLiveOutputBytes(streamId: string, offset: number, limit: number) {
    if (!this.liveStreamThread(streamId)) throw new Error("Unknown output stream");
    return this.readOutputBytes(streamId, offset, limit);
  }
  liveStreamThread(streamId: string): ThreadId | undefined {
    const current = this.readStatement(`
      SELECT s.thread_id FROM output_streams s JOIN item_previews p ON p.id=s.item_id
      WHERE s.id=? AND json_extract(p.item,'$.type')='tool_call'
        AND json_extract(p.item,'$.call.detail.kind')='shell'
      UNION ALL
      SELECT s.thread_id FROM item_text_streams s JOIN item_previews p ON p.id=s.item_id
      WHERE s.id=? AND (
        json_extract(p.item,'$.source.streamId')=s.id OR
        json_extract(p.item,'$.parts[' || s.part || '].source.streamId')=s.id
      ) LIMIT 1
    `).get(streamId, streamId);
    return current ? ThreadId.parse(current.thread_id) : undefined;
  }
  /** Internal archive read; historical callers check ownership and frozen length first. */
  readOutputBytes(streamId: string, offset: number, limit: number) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 256 * 1024
    )
      throw new Error("Invalid output range");
    const output = this.readStatement("SELECT size FROM output_streams WHERE id = ?").get(streamId);
    const stream =
      output ?? this.readStatement("SELECT size FROM item_text_streams WHERE id = ?").get(streamId);
    // Table names are daemon constants, never interpolated from wire input.
    const table = output ? "output_chunks" : "item_source_chunks";
    if (!stream) throw new Error("Unknown output stream");
    const size = Number(stream.size);
    if (offset >= size) return { bytes: Buffer.alloc(0), nextOffset: offset, eof: true };
    const end = Math.min(size, offset + limit);
    // Seek the predecessor using the primary key, then read only the intersecting range.
    const predecessor = this.readStatement(
      `SELECT offset FROM ${table} WHERE stream_id = ? AND offset <= ? ORDER BY offset DESC LIMIT 1`,
    ).get(streamId, offset);
    const start = predecessor ? Number(predecessor.offset) : offset;
    const chunks = this.readStatement(
      `SELECT offset, substr(bytes, MAX(0, ? - offset) + 1, MIN(length(bytes), ? - offset) - MAX(0, ? - offset)) AS bytes FROM ${table} WHERE stream_id = ? AND offset >= ? AND offset < ? ORDER BY offset`,
    ).all(offset, end, offset, streamId, start, end);
    const bytes = Buffer.concat(
      chunks.map((row) => {
        if (!(row.bytes instanceof Uint8Array)) throw new Error("Invalid output chunk");
        return Buffer.from(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength);
      }),
    );
    return {
      bytes,
      nextOffset: offset + bytes.length,
      eof: offset + bytes.length >= size,
    };
  }
  wirePage(threadId: ThreadId, before: number, limit: number, byteLimit: number) {
    return this.items.wirePage(threadId, before, limit, byteLimit);
  }
  page(threadId: ThreadId, before: number, limit: number, byteLimit?: number) {
    return this.items.page(threadId, before, limit, byteLimit);
  }
}
