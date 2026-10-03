import { z } from "zod";
import { appendTextSource, textPreview } from "./text-preview.ts";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { Item, EventPayload, ThreadId, type TextSource } from "@ace/protocol";
const StreamRow = z.object({
  id: z.string(),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
/** Page previews and indexed UTF-16 text streams. Delta work touches one target
 * and new bytes only; preview materialization happens on an explicit page read. */
export class ItemTextStore {
  private db: DatabaseSync;
  private prepared = new Map<string, StatementSync>();
  private target: StatementSync | undefined;
  private insert: StatementSync | undefined;
  private grow: StatementSync | undefined;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  private statement(sql: string): StatementSync {
    const previous = this.prepared.get(sql);
    if (previous) return previous;
    // Private constant SQL; reject additions beyond this fixed prepared-statement cap.
    if (this.prepared.size >= 24) throw new Error("Text statement capacity exceeded");
    const statement = this.db.prepare(sql);
    this.prepared.set(sql, statement);
    return statement;
  }
  source(
    item: Item,
    part: number,
    text: string,
    revision: number | string,
    threadId: ThreadId,
  ): TextSource {
    const streamId = `text:${JSON.stringify([item.id, part, revision])}`;
    this.statement(
      "INSERT OR IGNORE INTO item_text_streams (id, thread_id, item_id, part, size) VALUES (?, ?, ?, ?, ?)",
    ).run(streamId, threadId, item.id, part, text.length * 2);
    this.write(streamId, 0, text);
    return { streamId, bytes: text.length * 2, encoding: "utf-16le" };
  }
  private write(streamId: string, offset: number, text: string): void {
    const insert = (this.insert ??= this.statement(
      "INSERT OR IGNORE INTO item_source_chunks VALUES (?, ?, ?)",
    ));
    for (let start = 0; start < text.length; start += 32768)
      insert.run(
        streamId,
        offset + start * 2,
        Buffer.from(text.slice(start, start + 32768), "utf16le"),
      );
  }
  seed(item: Item, revision: number): void {
    const threadId = ThreadId.parse(
      this.statement("SELECT thread_id FROM items WHERE id=?").get(item.id)?.thread_id,
    );
    const plan = this.revision(item, revision, threadId);
    this.statement("DELETE FROM item_text_targets WHERE item_id=?").run(item.id);
    const source = appendTextSource(plan.item);
    if (source)
      this.statement("INSERT INTO item_text_targets VALUES (?,?)").run(item.id, source.streamId);
    this.statement(
      "INSERT INTO item_previews VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET item = excluded.item, target = excluded.target",
    ).run(item.id, JSON.stringify(plan.item), plan.target);
  }
  /** Retain a revision's sources without replacing the live preview. Used by log backfill. */
  revision(
    item: Item,
    revision: number | string,
    threadId: ThreadId,
  ): { item: Item; target: number } {
    const plan = textPreview(item);
    const preview = plan.item;
    for (const source of plan.sources) {
      const descriptor = this.source(item, source.part, source.text, revision, threadId);
      if (preview.type === "message") {
        const part = preview.parts[source.part];
        if (part?.type === "text") part.source = descriptor;
      } else if (preview.type === "reasoning" || preview.type === "notice")
        preview.source = descriptor;
    }
    return { item: preview, target: plan.target };
  }
  archiveAppend(source: TextSource, offset: number, text: string): void {
    this.write(source.streamId, offset, text);
    this.statement("UPDATE item_text_streams SET size=MAX(size,?) WHERE id=?").run(
      offset + text.length * 2,
      source.streamId,
    );
  }
  append(delta: Extract<EventPayload, { type: "item.delta" }>, revision: number): void {
    const target = (this.target ??= this.statement(
      "SELECT s.id, s.size FROM item_text_targets t JOIN item_text_streams s ON s.id=t.stream_id WHERE t.item_id=?",
    ));
    let row = target.get(delta.itemId);
    if (!row) {
      const stored = this.statement("SELECT item, target FROM item_previews WHERE id = ?").get(
        delta.itemId,
      );
      if (!stored) return;
      const item = Item.parse(JSON.parse(String(stored.item)));
      if (item.type !== "message" || delta.field !== "text") return;
      const threadId = ThreadId.parse(
        this.statement("SELECT thread_id FROM items WHERE id=?").get(item.id)?.thread_id,
      );
      const source = this.source(item, Number(stored.target), "", revision, threadId);
      this.statement("INSERT INTO item_text_targets VALUES (?,?)").run(item.id, source.streamId);
      item.parts.push({ type: "text", text: "", source });
      this.statement("UPDATE item_previews SET item = ? WHERE id = ?").run(
        JSON.stringify(item),
        item.id,
      );
      row = { id: source.streamId, size: 0 };
    }
    const decoded = StreamRow.parse(row);
    const id = decoded.id;
    const size = decoded.size;
    this.write(id, size, delta.append);
    const grow = (this.grow ??= this.statement(
      "UPDATE item_text_streams SET size = size + ? WHERE id = ?",
    ));
    grow.run(delta.append.length * 2, id);
  }
  initialize(): void {
    if (this.statement("SELECT id FROM item_preview_migration WHERE id = 1").get()) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of this.statement("SELECT id, item, created_seq FROM items").iterate()) {
        const item = Item.parse(JSON.parse(String(row.item)));
        this.seed(item, Number(row.created_seq));
        for (const chunk of this.statement(
          "SELECT seq, field, append FROM item_text_chunks WHERE item_id = ? ORDER BY seq",
        ).iterate(item.id)) {
          const payload = EventPayload.parse({
            type: "item.delta",
            itemId: item.id,
            agentId: item.agentId,
            field: chunk.field,
            append: JSON.parse(String(chunk.append)),
          });
          if (payload.type === "item.delta") this.append(payload, Number(chunk.seq));
        }
      }
      this.db.exec("INSERT INTO item_preview_migration VALUES (1); COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private preview(source: TextSource, units: number): string {
    source.bytes = z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(
        this.statement("SELECT size FROM item_text_streams WHERE id = ?").get(source.streamId)
          ?.size,
      );
    const end = Math.min(units * 2, source.bytes);
    const pieces: Buffer[] = [];
    for (const row of this.statement(
      "SELECT substr(bytes, 1, ? - offset) AS bytes FROM item_source_chunks WHERE stream_id = ? AND offset < ? ORDER BY offset",
    ).iterate(end, source.streamId, end)) {
      if (!(row.bytes instanceof Uint8Array)) throw new Error("Invalid text chunk");
      pieces.push(Buffer.from(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength));
    }
    return Buffer.concat(pieces).toString("utf16le");
  }
  read(id: string): Item {
    const row = this.statement("SELECT item FROM item_previews WHERE id = ?").get(id);
    if (!row) throw new Error("Missing item preview");
    const item = Item.parse(JSON.parse(String(row.item)));
    let remaining = 4096;
    if (item.type === "message")
      for (const part of item.parts)
        if (part.type === "text" && part.source) {
          part.text = this.preview(part.source, remaining);
          remaining -= part.text.length;
        }
    if ((item.type === "reasoning" || item.type === "notice") && item.source)
      item.text = this.preview(item.source, remaining);
    return item;
  }
}
