import { z } from "zod";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
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
  private readonly db: DatabaseSync;
  private readonly items: ItemStore;
  private readonly nextBlobId: () => string;
  constructor(db: DatabaseSync, nextBlobId: () => string) {
    this.db = db;
    this.items = new ItemStore(db);
    this.nextBlobId = nextBlobId;
  }
  /** Upgrade existing event logs once, preserving event ids and host sequences. */
  initialize(): void {
    this.items.initialize();
    if (this.db.prepare("SELECT id FROM payload_migration WHERE id = 1").get()) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of this.db.prepare("SELECT * FROM events ORDER BY seq").iterate()) {
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
          this.db
            .prepare(
              "INSERT INTO output_streams (id, thread_id, item_id) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
            )
            .run(streamId, threadId, item.id);
          const size = Number(
            this.db.prepare("SELECT size FROM output_streams WHERE id = ?").get(streamId)?.size,
          );
          const bytes = Buffer.from(output).subarray(size);
          // Bound new legacy chunks; range reads also support older unsplit BLOBs.
          for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
            this.db
              .prepare("INSERT INTO output_chunks VALUES (?, ?, ?)")
              .run(streamId, size + offset, bytes.subarray(offset, offset + 64 * 1024));
          }
          if (bytes.length) {
            this.db
              .prepare("UPDATE output_streams SET size = size + ? WHERE id = ?")
              .run(bytes.length, streamId);
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
        this.db
          .prepare("UPDATE events SET payload = ? WHERE seq = ?")
          .run(JSON.stringify(event.payload), event.seq);
      }
      this.db.exec("INSERT INTO payload_migration VALUES (1); COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  cap(payload: EventPayload, threadId: ThreadId): EventPayload {
    const copy = structuredClone(payload);
    const capRaw = (raw: RawPayload[]): RawPayload[] =>
      raw.map((value) => {
        if (!("data" in value)) return value;
        const serialized = JSON.stringify(value.data);
        if (serialized === undefined) return value;
        const bytes = Buffer.from(serialized);
        if (bytes.length <= 64 * 1024) return value;
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const existing = this.db
          .prepare("SELECT id FROM blobs WHERE thread_id = ? AND sha256 = ?")
          .get(threadId, sha256);
        const id = String(existing?.id ?? this.nextBlobId());
        if (!existing)
          this.db.prepare("INSERT INTO blobs VALUES (?, ?, ?, ?)").run(id, sha256, bytes, threadId);
        return {
          type: value.type,
          ...(value.name === undefined ? {} : { name: value.name }),
          blobRef: id,
          size: bytes.length,
          preview: utf8Slice(serialized, 2048),
        };
      });
    if (copy.type === "item.created" || copy.type === "item.updated") {
      if (copy.item.type === "tool_call") copy.item.call.raw = capRaw(copy.item.call.raw);
      else if ("raw" in copy.item) copy.item.raw = capRaw(copy.item.raw);
    } else if (copy.type === "interaction.opened")
      copy.interaction.raw = capRaw(copy.interaction.raw);
    else if (copy.type === "background_task.started") copy.task.raw = capRaw(copy.task.raw);
    return copy;
  }
  persist(event: Event): void {
    const p = event.payload;
    if (p.type === "item.created" || p.type === "item.updated") {
      this.items.upsert(event, p.item);
    } else if (p.type === "item.delta") {
      if (p.field !== "output") {
        this.items.append(event, p);
        return;
      }
      const row = this.db
        .prepare("SELECT item FROM items WHERE id = ? AND thread_id = ?")
        .get(p.itemId, event.threadId);
      if (!row) {
        if (p.field === "output") throw new Error("Output needs a shell item");
        return;
      }
      const item = Item.parse(JSON.parse(String(row.item)));
      if (p.field === "output" && item.type === "tool_call" && item.call.detail.kind === "shell") {
        const streamId = item.call.detail.output?.streamId ?? outputStreamId(item.id);
        this.db
          .prepare(
            "INSERT INTO output_streams (id, thread_id, item_id) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
          )
          .run(streamId, event.threadId, item.id);
        const stream = this.db.prepare("SELECT * FROM output_streams WHERE id = ?").get(streamId);
        if (stream?.thread_id !== event.threadId || stream.item_id !== item.id)
          throw new Error("Stream outside item scope");
        const bytes = Buffer.from(p.append);
        if (bytes.length)
          this.db
            .prepare("INSERT INTO output_chunks VALUES (?, ?, ?)")
            .run(streamId, Number(stream.size), bytes);
        this.db
          .prepare("UPDATE output_streams SET size = size + ? WHERE id = ?")
          .run(bytes.length, streamId);
      }
      if (!applyDelta(item, p.field, p.append)) return;
      const body = JSON.stringify(item);
      this.db.prepare("UPDATE items SET item = ? WHERE id = ?").run(body, item.id);
      this.db
        .prepare("UPDATE item_heads SET size = ? WHERE id = ?")
        .run(Buffer.byteLength(body), item.id);
    }
  }
  streamThread(streamId: string): ThreadId | undefined {
    const row = this.db.prepare("SELECT thread_id FROM output_streams WHERE id = ?").get(streamId);
    return row ? ThreadId.parse(row.thread_id) : undefined;
  }
  readOutput(streamId: string, offset: number, limit: number) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 256 * 1024
    )
      throw new Error("Invalid output range");
    const stream = this.db.prepare("SELECT size FROM output_streams WHERE id = ?").get(streamId);
    if (!stream) throw new Error("Unknown output stream");
    const size = Number(stream.size);
    if (offset >= size) return { bytes: "", nextOffset: offset, eof: true };
    const end = Math.min(size, offset + limit);
    // Seek the predecessor using the primary key, then read only the intersecting range.
    const predecessor = this.db
      .prepare(
        "SELECT offset FROM output_chunks WHERE stream_id = ? AND offset <= ? ORDER BY offset DESC LIMIT 1",
      )
      .get(streamId, offset);
    const start = predecessor ? Number(predecessor.offset) : offset;
    const chunks = this.db
      .prepare(
        "SELECT offset, substr(bytes, max(0, ? - offset) + 1, ? - max(offset, ?)) AS bytes FROM output_chunks WHERE stream_id = ? AND offset >= ? AND offset < ? ORDER BY offset",
      )
      .all(offset, end, offset, streamId, start, end);
    const bytes = Buffer.concat(
      chunks.map((row) => {
        if (!(row.bytes instanceof Uint8Array)) throw new Error("Invalid output chunk");
        return Buffer.from(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength);
      }),
    );
    return {
      bytes: bytes.toString("base64"),
      nextOffset: offset + bytes.length,
      eof: offset + bytes.length >= size,
    };
  }
  page(threadId: ThreadId, before: number, limit: number, byteLimit?: number) {
    return this.items.page(threadId, before, limit, byteLimit);
  }
}
