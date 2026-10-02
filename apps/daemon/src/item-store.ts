import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { EventPayload, Item, type Event, type ItemsPage, type ThreadId } from "@ace/protocol";
import { applyDelta } from "@ace/projection";

function decodeAppend(value: unknown): string {
  return z.string().parse(JSON.parse(z.string().parse(value)));
}
function textMetadata(item: Item): { prefix: number; lastUnit: number } {
  const last = item.type === "message" ? item.parts.at(-1) : undefined;
  const text =
    item.type === "reasoning" || item.type === "notice"
      ? item.text
      : last?.type === "text"
        ? last.text
        : "";
  return {
    lastUnit: text.length ? text.charCodeAt(text.length - 1) : -1,
    prefix:
      item.type === "message" && last?.type !== "text"
        ? Buffer.byteLength(JSON.stringify({ type: "text", text: "" })) +
          (item.parts.length ? 1 : 0)
        : 0,
  };
}
function appendSize(append: string, lastUnit: number): number {
  const first = append.charCodeAt(0);
  const joinsPair = lastUnit >= 0xd800 && lastUnit <= 0xdbff && first >= 0xdc00 && first <= 0xdfff;
  // Two independently escaped lone surrogates (6+6 bytes) become one 4-byte code point.
  return Buffer.byteLength(JSON.stringify(append)) - 2 - (joinsPair ? 8 : 0);
}
/** Authoritative bodies plus append-only text: delta writes never read or rewrite history. */
export class ItemStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  /** Rebuild encoding metadata once after migration, recovering old chunks from the event log. */
  initialize(): void {
    if (this.db.prepare("SELECT id FROM text_encoding_migration WHERE id = 1").get()) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of this.db.prepare("SELECT id, item FROM items").iterate()) {
        const item = Item.parse(JSON.parse(String(row.item)));
        let { prefix, lastUnit } = textMetadata(item);
        let size = Buffer.byteLength(JSON.stringify(item));
        for (const chunk of this.db
          .prepare("SELECT append FROM item_text_chunks WHERE item_id = ? ORDER BY seq")
          .iterate(item.id)) {
          const append = decodeAppend(chunk.append);
          size += appendSize(append, lastUnit) + prefix;
          prefix = 0;
          if (append.length) lastUnit = append.charCodeAt(append.length - 1);
        }
        this.db
          .prepare(
            "UPDATE item_heads SET size = ?, text_prefix = ?, text_last_unit = ? WHERE id = ?",
          )
          .run(size, prefix, lastUnit, item.id);
      }
      this.db.exec("INSERT INTO text_encoding_migration VALUES (1); COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  upsert(event: Event, item: Item): void {
    const existing = this.db.prepare("SELECT thread_id FROM items WHERE id = ?").get(item.id);
    if (existing && existing.thread_id !== event.threadId) throw new Error("Item outside thread");
    const body = JSON.stringify(item);
    const { prefix, lastUnit } = textMetadata(item);
    this.db
      .prepare(
        "INSERT INTO items VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET item = excluded.item",
      )
      .run(item.id, event.threadId, event.seq, body);
    this.db
      .prepare(`INSERT INTO item_heads VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET size = excluded.size, item_type = excluded.item_type, text_prefix = excluded.text_prefix, text_last_unit = excluded.text_last_unit`)
      .run(
        item.id,
        event.threadId,
        event.seq,
        Buffer.byteLength(body),
        item.type,
        prefix,
        lastUnit,
      );
    this.db.prepare("DELETE FROM item_text_chunks WHERE item_id = ?").run(item.id);
  }
  append(event: Event, delta: Extract<EventPayload, { type: "item.delta" }>): void {
    const row = this.db
      .prepare(
        "SELECT item_type, text_prefix, text_last_unit FROM item_heads WHERE id = ? AND thread_id = ?",
      )
      .get(delta.itemId, event.threadId);
    if (
      !row ||
      !(
        row.item_type === "reasoning" ||
        row.item_type === "notice" ||
        (row.item_type === "message" && delta.field === "text")
      )
    )
      return;
    if (!delta.append.length && !Number(row.text_prefix)) return;
    const size = appendSize(delta.append, Number(row.text_last_unit)) + Number(row.text_prefix);
    const lastUnit = delta.append.length
      ? delta.append.charCodeAt(delta.append.length - 1)
      : Number(row.text_last_unit);
    this.db
      .prepare("INSERT INTO item_text_chunks VALUES (?, ?, ?, ?)")
      .run(delta.itemId, event.seq, delta.field, JSON.stringify(delta.append));
    this.db
      .prepare(
        "UPDATE item_heads SET size = size + ?, text_prefix = 0, text_last_unit = ? WHERE id = ?",
      )
      .run(size, lastUnit, delta.itemId);
  }
  private materialize(id: string, body: unknown): Item {
    const item = Item.parse(JSON.parse(String(body)));
    let field: unknown;
    const appends: string[] = [];
    // Stream rows instead of retaining their objects. Accepted fields share one append target.
    for (const row of this.db
      .prepare("SELECT field, append FROM item_text_chunks WHERE item_id = ? ORDER BY seq")
      .iterate(id)) {
      field ??= row.field;
      appends.push(decodeAppend(row.append));
    }
    if (appends.length) {
      const delta = EventPayload.parse({
        type: "item.delta",
        itemId: item.id,
        agentId: item.agentId,
        field,
        append: appends.join(""),
      });
      if (delta.type !== "item.delta") throw new Error("Invalid text delta");
      applyDelta(item, delta.field, delta.append);
    }
    return item;
  }
  page(threadId: ThreadId, before: number, limit: number, byteLimit?: number): ItemsPage {
    if (
      !Number.isSafeInteger(before) ||
      before < 1 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new Error("Invalid item page");
    const rows = this.db
      .prepare(
        "SELECT id, created_seq, size FROM item_heads WHERE thread_id = ? AND created_seq < ? ORDER BY created_seq DESC LIMIT ?",
      )
      .all(threadId, before, limit + 1);
    let count = 0;
    // Budget both items:{} and itemOrder:[], including serialized ids, colons and commas.
    let bytes = 4;
    while (count < Math.min(rows.length, limit)) {
      const row = rows[count];
      if (!row) break;
      const size =
        Number(row.size) + 2 * Buffer.byteLength(JSON.stringify(row.id)) + 1 + (count ? 2 : 0);
      if (bytes + size > (byteLimit ?? Infinity)) break;
      bytes += size;
      count++;
    }
    const oldestRow = rows[count - 1];
    const oldest = oldestRow ? Number(oldestRow.created_seq) : before;
    const items = count
      ? this.db
          .prepare(
            "SELECT id, item FROM items WHERE thread_id = ? AND created_seq >= ? AND created_seq < ? ORDER BY created_seq",
          )
          .all(threadId, oldest, before)
          .map((row) => this.materialize(String(row.id), row.item))
      : [];
    return { threadId, items, itemsBefore: rows.length > count ? oldest : null };
  }
}
