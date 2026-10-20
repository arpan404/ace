import { ItemTextStore } from "./item-text-store.ts";
import { ItemPageCapacityExceeded } from "./item-page-capacity.ts";
import { z } from "zod";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  EventPayload,
  Item,
  ItemId,
  type Event,
  type ItemsPage,
  type ThreadId,
} from "@ace/protocol";
import { applyDelta, inRootLane, retainedTail } from "@ace/projection";

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
  private readonly texts: ItemTextStore;
  private readonly db: DatabaseSync;
  private readonly statement: (sql: string) => StatementSync;
  constructor(db: DatabaseSync, statement: (sql: string) => StatementSync) {
    this.statement = statement;
    this.db = db;
    this.texts = new ItemTextStore(db);
  }
  /** Rebuild encoding metadata once after migration, recovering old chunks from the event log. */
  initialize(): void {
    if (this.statement("SELECT id FROM text_encoding_migration WHERE id = 1").get()) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of this.statement("SELECT id, item FROM items").iterate()) {
        const item = Item.parse(JSON.parse(String(row.item)));
        let { prefix, lastUnit } = textMetadata(item);
        let size = Buffer.byteLength(JSON.stringify(item));
        for (const chunk of this.statement(
          "SELECT append FROM item_text_chunks WHERE item_id = ? ORDER BY seq",
        ).iterate(item.id)) {
          const append = decodeAppend(chunk.append);
          size += appendSize(append, lastUnit) + prefix;
          prefix = 0;
          if (append.length) lastUnit = append.charCodeAt(append.length - 1);
        }
        this.statement(
          "UPDATE item_heads SET size = ?, text_prefix = ?, text_last_unit = ? WHERE id = ?",
        ).run(size, prefix, lastUnit, item.id);
      }
      this.db.exec("INSERT INTO text_encoding_migration VALUES (1); COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  initializePreviews(): void {
    this.texts.initialize();
  }
  upsert(event: Event, item: Item): void {
    const existing = this.statement("SELECT thread_id FROM items WHERE id = ?").get(item.id);
    if (existing && existing.thread_id !== event.threadId) throw new Error("Item outside thread");
    const body = JSON.stringify(item);
    const { prefix, lastUnit } = textMetadata(item);
    this.statement(
      "INSERT INTO items VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET item = excluded.item",
    ).run(item.id, event.threadId, event.seq, body);
    this.statement(`INSERT INTO item_heads VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET size = excluded.size, item_type = excluded.item_type, text_prefix = excluded.text_prefix, text_last_unit = excluded.text_last_unit`).run(
      item.id,
      event.threadId,
      event.seq,
      Buffer.byteLength(body),
      item.type,
      prefix,
      lastUnit,
      item.agentId ?? "",
    );
    this.statement("DELETE FROM item_text_chunks WHERE item_id = ?").run(item.id);
    this.texts.seed(item, event.seq);
  }
  append(event: Event, delta: Extract<EventPayload, { type: "item.delta" }>): void {
    const row = this.statement(
      "SELECT item_type, text_prefix, text_last_unit FROM item_heads WHERE id = ? AND thread_id = ?",
    ).get(delta.itemId, event.threadId);
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
    this.texts.append(delta, event.seq);
    const size = appendSize(delta.append, Number(row.text_last_unit)) + Number(row.text_prefix);
    const lastUnit = delta.append.length
      ? delta.append.charCodeAt(delta.append.length - 1)
      : Number(row.text_last_unit);
    this.statement("INSERT INTO item_text_chunks VALUES (?, ?, ?, ?)").run(
      delta.itemId,
      event.seq,
      delta.field,
      JSON.stringify(delta.append),
    );
    this.statement(
      "UPDATE item_heads SET size = size + ?, text_prefix = 0, text_last_unit = ? WHERE id = ?",
    ).run(size, lastUnit, delta.itemId);
  }
  private materialize(id: string, body: unknown): Item {
    const item = Item.parse(JSON.parse(String(body)));
    let field: unknown;
    const appends: string[] = [];
    // Stream rows instead of retaining their objects. Accepted fields share one append target.
    for (const row of this.statement(
      "SELECT field, append FROM item_text_chunks WHERE item_id = ? ORDER BY seq",
    ).iterate(id)) {
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
  wirePage(
    threadId: ThreadId,
    before: number,
    limit: number,
    byteLimit: number,
  ): Omit<ItemsPage, "seq"> {
    const rows = this.statement(
      "SELECT id, created_seq, size, item_type FROM item_heads WHERE thread_id = ? AND created_seq < ? ORDER BY created_seq DESC LIMIT ?",
    ).all(threadId, before, limit + 1);
    const decoded = z
      .array(
        z.object({
          id: ItemId,
          created_seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          size: z.number().int().nonnegative(),
          // Only text previews are special-cased below; any other item type, including ones
          // added after this reader, pages by its stored size.
          item_type: z.string().min(1).max(64),
        }),
      )
      .max(201)
      .parse(rows);
    const items: Item[] = [];
    const cursors: [string, number][] = [];
    let bytes = 512;
    for (const row of decoded.slice(0, limit)) {
      const id = String(row.id);
      const overhead = Buffer.byteLength(JSON.stringify(id)) + 64;
      const preview =
        row.item_type === "message" || row.item_type === "notice" || row.item_type === "reasoning";
      // The authoritative encoded size is already persisted by the payload owner.
      // Tool/artifact details have no smaller wire preview: reject them before
      // loading their body into JS, parsing it, or allocating its serialized copy.
      // Text items instead carry bounded previews and separate full-text sources.
      if (!preview && bytes + row.size + overhead > byteLimit) {
        if (!items.length) throw new ItemPageCapacityExceeded("Item detail exceeds page capacity");
        break;
      }
      const item = this.pageItem(id, row.item_type);
      const size = Buffer.byteLength(JSON.stringify(item)) + overhead;
      if (bytes + size > byteLimit) {
        if (!items.length) throw new ItemPageCapacityExceeded("Item detail exceeds page capacity");
        break;
      }
      items.push(item);
      cursors.push([id, Number(row.created_seq)]);
      bytes += size;
    }
    items.reverse();
    return {
      threadId,
      items,
      itemSeqs: Object.fromEntries(cursors),
      itemsBefore: rows.length > items.length ? (cursors.at(-1)?.[1] ?? before) : null,
    };
  }
  /** An item as a page shows it: text cut to its bounded preview, other bodies whole. */
  private pageItem(id: string, type: string): Item {
    return type === "message" || type === "notice" || type === "reasoning"
      ? this.texts.read(id)
      : this.materialize(id, this.statement("SELECT item FROM items WHERE id = ?").get(id)?.item);
  }
  /** The newest item created before `before`, as a page shows it, with its creation cursor. */
  newestBefore(threadId: ThreadId, before: number): { item: Item; seq: number } | undefined {
    const row = this.statement(
      "SELECT id, created_seq, item_type FROM item_heads WHERE thread_id = ? AND created_seq < ? ORDER BY created_seq DESC LIMIT 1",
    ).get(threadId, before);
    if (!row) return undefined;
    const head = z
      .object({
        id: ItemId,
        created_seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        item_type: z.string().min(1).max(64),
      })
      .parse(row);
    return { item: this.pageItem(String(head.id), head.item_type), seq: head.created_seq };
  }
  hasItemBefore(threadId: ThreadId, before: number): boolean {
    return (
      this.statement(
        "SELECT 1 FROM item_heads WHERE thread_id = ? AND created_seq < ? LIMIT 1",
      ).get(threadId, before) !== undefined
    );
  }
  /** One item as a step list shows it: text cut to its bounded preview, tool bodies whole. */
  stepItem(threadId: ThreadId, itemId: string): Item | undefined {
    const head = this.statement("SELECT item_type FROM item_heads WHERE thread_id=? AND id=?").get(
      threadId,
      itemId,
    );
    if (!head) return undefined;
    if (
      head.item_type === "message" ||
      head.item_type === "notice" ||
      head.item_type === "reasoning"
    )
      return this.texts.read(itemId);
    const row = this.statement("SELECT item FROM items WHERE id = ? AND thread_id = ?").get(
      itemId,
      threadId,
    );
    return row ? this.materialize(itemId, row.item) : undefined;
  }
  createdSeq(threadId: ThreadId, itemId: string): number | undefined {
    const row = this.statement("SELECT created_seq FROM item_heads WHERE thread_id=? AND id=?").get(
      threadId,
      itemId,
    );
    return row ? Number(row.created_seq) : undefined;
  }
  window(threadId: ThreadId, aroundSeq: number, before: number, after: number, byteLimit: number) {
    const target =
      this.statement(
        "SELECT created_seq FROM item_heads WHERE thread_id=? AND created_seq>=? ORDER BY created_seq LIMIT 1",
      ).get(threadId, aroundSeq) ??
      this.statement(
        "SELECT created_seq FROM item_heads WHERE thread_id=? ORDER BY created_seq DESC LIMIT 1",
      ).get(threadId);
    if (!target)
      return {
        threadId,
        targetSeq: null,
        items: [],
        itemSeqs: {},
        itemsBefore: null,
        itemsAfter: null,
      };
    const targetSeq = Number(target.created_seq);
    const older = this.statement(
      "SELECT created_seq FROM item_heads WHERE thread_id=? AND created_seq<? ORDER BY created_seq DESC LIMIT ?",
    ).all(threadId, targetSeq, before);
    const newer = this.statement(
      "SELECT created_seq FROM item_heads WHERE thread_id=? AND created_seq>? ORDER BY created_seq LIMIT ?",
    ).all(threadId, targetSeq, after);
    const selected = new Map<number, Item>();
    let bytes = 512;
    // Read the target first so a byte-limited window always includes the jump point.
    const add = (seq: number): boolean => {
      let page: Omit<ItemsPage, "seq">;
      try {
        // wirePage reserves 512 envelope bytes itself. Pass only this window's
        // remaining item allowance so neighbor preflight also rejects details
        // that fit a standalone page but cannot fit alongside the jump target.
        page = this.wirePage(threadId, seq + 1, 1, byteLimit - bytes + 512);
      } catch (error) {
        if (seq !== targetSeq && error instanceof ItemPageCapacityExceeded) return false;
        throw error;
      }
      const item = page.items[0];
      if (!item) return false;
      const size =
        Buffer.byteLength(JSON.stringify(item)) + Buffer.byteLength(JSON.stringify(item.id)) + 64;
      bytes += size;
      selected.set(seq, item);
      return true;
    };
    if (!add(targetSeq)) throw new Error("Item detail exceeds window capacity");
    // Alternate sides until the budget is reached, preserving one contiguous interval.
    let left = 0,
      right = 0;
    while (left < older.length || right < newer.length) {
      const old = older[left];
      if (old) {
        if (!add(Number(old.created_seq))) break;
        left++;
      }
      const next = newer[right];
      if (next) {
        if (!add(Number(next.created_seq))) break;
        right++;
      }
    }
    const entries = [...selected].toSorted((a, b) => a[0] - b[0]);
    const first = entries[0]?.[0] ?? targetSeq,
      last = entries.at(-1)?.[0] ?? targetSeq;
    return {
      threadId,
      targetSeq,
      items: entries.map(([, item]) => item),
      itemSeqs: Object.fromEntries(entries.map(([seq, item]) => [item.id, seq])),
      itemsBefore: this.statement(
        "SELECT 1 FROM item_heads WHERE thread_id=? AND created_seq<? LIMIT 1",
      ).get(threadId, first)
        ? first
        : null,
      itemsAfter: this.statement(
        "SELECT 1 FROM item_heads WHERE thread_id=? AND created_seq>? LIMIT 1",
      ).get(threadId, last)
        ? last
        : null,
    };
  }
  /**
   * A snapshot's transcript tail: the items the client's bounded window holds after its trim
   * (`retainedTail`, ADR 0062), whole, in creation order. Only the newest `limit + 1` heads and
   * the root lane's newest `limit / 2` (the root agent's and the thread's own) can be chosen, so
   * three indexed reads cover any thread length.
   * If those items exceed `byteLimit`, the same rule picks a smaller window that fits; a newest
   * item larger than the whole budget still shows alone, as its bounded preview.
   */
  tail(
    threadId: ThreadId,
    rootAgentId: string | undefined,
    limit: number,
    byteLimit: number,
  ): Omit<ItemsPage, "seq"> {
    const Head = z.object({
      id: ItemId,
      created_seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      size: z.number().int().nonnegative(),
      agent_id: z.string(),
    });
    const columns = "SELECT id, created_seq, size, agent_id FROM item_heads WHERE thread_id = ?";
    // The root lane is the root agent's items and the thread's own (no agent): one indexed
    // read each, never one IN query, which would sort the whole lane.
    const lane = (agentId: string) =>
      this.statement(`${columns} AND agent_id = ? ORDER BY created_seq DESC LIMIT ?`).all(
        threadId,
        agentId,
        Math.floor(limit / 2),
      );
    const rows = [
      ...this.statement(`${columns} ORDER BY created_seq DESC LIMIT ?`).all(threadId, limit + 1),
      ...(rootAgentId === undefined ? [] : lane(rootAgentId)),
      ...lane(""),
    ];
    const heads = new Map<number, z.infer<typeof Head>>();
    for (const row of z
      .array(Head)
      .max(3 * limit + 1)
      .parse(rows))
      heads.set(row.created_seq, row);
    const sorted = [...heads.values()].toSorted((a, b) => a.created_seq - b.created_seq);
    const entries = sorted.map((head) => ({
      id: String(head.id),
      seq: head.created_seq,
      root: inRootLane(head.agent_id, rootAgentId),
    }));
    const sizes = new Map(sorted.map((head) => [String(head.id), head.size]));
    // Budget both items:{} and itemOrder:[], including serialized ids, colons and commas.
    const bytes = (ids: readonly { id: string }[]) =>
      ids.reduce(
        (total, { id }, index) =>
          total +
          (sizes.get(id) ?? 0) +
          2 * Buffer.byteLength(JSON.stringify(id)) +
          1 +
          (index ? 2 : 0),
        4,
      );
    let capacity = Math.min(limit, entries.length);
    let tail = retainedTail(entries, capacity);
    while (capacity > 1 && bytes(tail.kept) > byteLimit) tail = retainedTail(entries, --capacity);
    // A newest item larger than the whole budget still shows, as its bounded text preview.
    const preview = tail.kept.length === 1 && bytes(tail.kept) > byteLimit;
    const kept = tail.kept.flatMap((entry) => {
      const item = preview
        ? this.stepItem(threadId, entry.id)
        : this.materialize(
            entry.id,
            this.statement("SELECT item FROM items WHERE id = ?").get(entry.id)?.item,
          );
      return item ? [{ item, seq: entry.seq ?? 0 }] : [];
    });
    return {
      threadId,
      items: kept.map((entry) => entry.item),
      itemSeqs: Object.fromEntries(kept.map((entry) => [entry.item.id, entry.seq])),
      itemsBefore: tail.before ?? null,
    };
  }
  page(
    threadId: ThreadId,
    before: number,
    limit: number,
    byteLimit?: number,
  ): Omit<ItemsPage, "seq"> {
    if (
      !Number.isSafeInteger(before) ||
      before < 1 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new Error("Invalid item page");
    const rows = this.statement(
      "SELECT id, created_seq, size FROM item_heads WHERE thread_id = ? AND created_seq < ? ORDER BY created_seq DESC LIMIT ?",
    ).all(threadId, before, limit + 1);
    let count = 0;
    // Budget both items:{} and itemOrder:[], including serialized ids, colons and commas.
    let bytes = 4;
    while (count < Math.min(rows.length, limit)) {
      const row = rows[count];
      if (!row) break;
      const size =
        Number(row.size) + 2 * Buffer.byteLength(JSON.stringify(row.id)) + 1 + (count ? 2 : 0);
      if (bytes + size > (byteLimit ?? 1024 * 1024) && (count > 0 || byteLimit !== undefined))
        break;
      bytes += size;
      count++;
    }
    // A newest item larger than the whole budget still shows, as its bounded text preview.
    const newest = rows[0];
    const oversized =
      count === 0 && newest ? this.stepItem(threadId, String(newest.id)) : undefined;
    if (oversized) count = 1;
    const oldestRow = rows[count - 1];
    const oldest = oldestRow ? Number(oldestRow.created_seq) : before;
    const items = oversized
      ? [oversized]
      : count
        ? this.statement(
            "SELECT id, item FROM items WHERE thread_id = ? AND created_seq >= ? AND created_seq < ? ORDER BY created_seq",
          )
            .all(threadId, oldest, before)
            .map((row) => this.materialize(String(row.id), row.item))
        : [];
    return {
      threadId,
      items,
      itemSeqs: Object.fromEntries(
        rows.slice(0, count).map((row) => [String(row.id), Number(row.created_seq)]),
      ),
      itemsBefore: rows.length > count ? oldest : null,
    };
  }
}
