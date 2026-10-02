import type { DatabaseSync } from "node:sqlite";
import { EventPayload, Item, type Event, type ItemsPage, type ThreadId } from "@ace/protocol";
import { applyDelta } from "@ace/projection";

/** Authoritative bodies plus append-only text: delta writes never read or rewrite history. */
export class ItemStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  upsert(event: Event, item: Item): void {
    const existing = this.db.prepare("SELECT thread_id FROM items WHERE id = ?").get(item.id);
    if (existing && existing.thread_id !== event.threadId) throw new Error("Item outside thread");
    const body = JSON.stringify(item);
    const prefix =
      item.type === "message" && item.parts.at(-1)?.type !== "text"
        ? Buffer.byteLength(JSON.stringify({ type: "text", text: "" })) +
          (item.parts.length ? 1 : 0)
        : 0;
    this.db
      .prepare(
        "INSERT INTO items VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET item = excluded.item",
      )
      .run(item.id, event.threadId, event.seq, body);
    this.db
      .prepare(`INSERT INTO item_heads VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET size = excluded.size, item_type = excluded.item_type, text_prefix = excluded.text_prefix`)
      .run(item.id, event.threadId, event.seq, Buffer.byteLength(body), item.type, prefix);
    this.db.prepare("DELETE FROM item_text_chunks WHERE item_id = ?").run(item.id);
  }
  append(event: Event, delta: Extract<EventPayload, { type: "item.delta" }>): void {
    const row = this.db
      .prepare("SELECT item_type, text_prefix FROM item_heads WHERE id = ? AND thread_id = ?")
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
    const size = Buffer.byteLength(JSON.stringify(delta.append)) - 2 + Number(row.text_prefix);
    this.db
      .prepare("INSERT INTO item_text_chunks VALUES (?, ?, ?, ?)")
      .run(delta.itemId, event.seq, delta.field, delta.append);
    this.db
      .prepare("UPDATE item_heads SET size = size + ?, text_prefix = 0 WHERE id = ?")
      .run(size, delta.itemId);
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
      if (typeof row.append !== "string") throw new Error("Invalid text chunk");
      appends.push(row.append);
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
