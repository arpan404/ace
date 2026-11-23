import { decodeStoredItem, storedItem, untrusted, type StoredTrust } from "./stored-decode.ts";
import { z } from "zod";
import { appendTextSource, hasTextPreview, textPreview } from "./text-preview.ts";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { Item, EventPayload, ThreadId, type TextSource } from "@ace/protocol";
const StreamSize = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const StreamRow = z.object({ id: z.string(), size: StreamSize });

/** A byte range `[start, end)` of one stream. */
export interface StreamRange {
  id: string;
  start: number;
  end: number;
}

/** One stored chunk row, as the slice reads it. */
export interface StreamChunk {
  offset: number;
  bytes: Uint8Array;
}

/** The first `units` of a stream live in `[0, min(units * 2, size))`. */
export function headRange(size: number, units: number): [number, number] {
  return [0, Math.min(units * 2, size)];
}

/** The last `units` of a stream live in `[max(0, size - units * 2), size)`. */
export function tailRange(size: number, units: number): [number, number] {
  return [Math.max(0, size - units * 2), size];
}

/** Drop a leading low surrogate and its byte offset, so text never starts mid-pair. */
export function trimLowStart(text: string, start: number): { text: string; start: number } {
  const first = text.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) return { text: text.slice(1), start: start + 2 };
  return { text, start };
}

/** The text in bytes `[start, end)` of already-read chunk rows, decoded as UTF-16LE. */
export function sliceByteRows(rows: StreamChunk[], start: number, end: number): string {
  if (end <= start) return "";
  const pieces: Buffer[] = [];
  // A chunk holds at most 32,768 units (`write`), so one starting before `start - 65536` ends
  // before it: the primary key bounds the scan to the chunks that hold the range.
  for (const row of rows) {
    // Checked by its internal slot, not instanceof: a host realm (a jsdom test) has its own Uint8Array.
    if (!ArrayBuffer.isView(row.bytes)) throw new Error("Invalid text chunk");
    const offset = Number(row.offset);
    const bytes = Buffer.from(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength);
    const from = Math.max(0, start - offset);
    const to = Math.min(bytes.length, end - offset);
    if (to > from) pieces.push(bytes.subarray(from, to));
  }
  return Buffer.concat(pieces).toString("utf16le");
}

/** An item's text sources in the order `fill` reads them: streaming reads newest first. */
export function sourcesInFillOrder(item: Item): TextSource[] {
  const streaming = !item.complete;
  if (item.type === "message") {
    const parts = streaming ? item.parts.toReversed() : item.parts;
    return parts.flatMap((part) => (part.type === "text" && part.source ? [part.source] : []));
  }
  if ((item.type === "reasoning" || item.type === "notice") && item.source) return [item.source];
  return [];
}
/** Page previews and indexed UTF-16 text streams. Delta work touches one target
 * and new bytes only; preview materialization happens on an explicit page read. */
export class ItemTextStore {
  private db: DatabaseSync;
  private prepared = new Map<string, StatementSync>();
  private target: StatementSync | undefined;
  private insert: StatementSync | undefined;
  private grow: StatementSync | undefined;
  /** Which previews are read as stored, by their item's creation sequence (`isTrusted`). */
  private readonly trust: StoredTrust;
  constructor(db: DatabaseSync, trust: StoredTrust = untrusted()) {
    this.db = db;
    this.trust = trust;
  }
  /**
   * A stored preview, trusted by its item's creation sequence like the item body (`storedItem`):
   * only this build writes previews of the items it created. One with no item row is decoded.
   */
  private preview(id: string): { item: Item; target: unknown } | undefined {
    const row = this.statement(
      "SELECT p.item, p.target, i.created_seq FROM item_previews p LEFT JOIN items i ON i.id = p.id WHERE p.id = ?",
    ).get(id);
    if (!row) return undefined;
    const created = row.created_seq === null ? Number.NEGATIVE_INFINITY : Number(row.created_seq);
    return { item: storedItem(created, String(row.item), this.trust), target: row.target };
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
    if (!hasTextPreview(item)) {
      // A non-text preview would be a second full copy of `items.item`: nothing reads it.
      this.statement("DELETE FROM item_text_targets WHERE item_id=?").run(item.id);
      this.statement("DELETE FROM item_previews WHERE id=?").run(item.id);
      return;
    }
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
      const stored = this.preview(delta.itemId);
      if (!stored) return;
      const item = stored.item;
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
        const item = decodeStoredItem(JSON.parse(String(row.item)));
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
  /** The stream's whole length now, which the stored descriptor may trail. */
  private size(source: TextSource): number {
    return StreamSize.parse(
      this.statement("SELECT size FROM item_text_streams WHERE id = ?").get(source.streamId)?.size,
    );
  }
  /** Fill `item`'s carried text from `size` and `slice`, shared by single and batched reads. */
  private fill(
    item: Item,
    sizeOf: (source: TextSource) => number,
    slice: (streamId: string, start: number, end: number) => string,
  ): Item {
    let remaining = 4096;
    // Text still streaming shows its newest end, marked so deltas keep extending it; finished
    // text shows from its start.
    const streaming = !item.complete;
    const head = (source: TextSource, units: number): string => {
      source.bytes = sizeOf(source);
      delete source.offset;
      const [start, end] = headRange(source.bytes, units);
      return slice(source.streamId, start, end);
    };
    const tail = (source: TextSource, units: number): string => {
      source.bytes = sizeOf(source);
      const [start, end] = tailRange(source.bytes, units);
      const cut = trimLowStart(slice(source.streamId, start, end), start);
      if (cut.start) source.offset = cut.start;
      else delete source.offset;
      return cut.text;
    };
    const read = (source: TextSource) =>
      streaming ? tail(source, remaining) : head(source, remaining);
    for (const source of sourcesInFillOrder(item)) {
      const text = read(source);
      // The part or item carrying this source holds the text just read.
      if (item.type === "message") {
        const part = item.parts.find((entry) => entry.type === "text" && entry.source === source);
        if (part?.type === "text") part.text = text;
      } else if (item.type === "reasoning" || item.type === "notice") {
        if (item.source === source) item.text = text;
      }
      remaining -= text.length;
    }
    return item;
  }
  /** The text in bytes [start, end) of a stream, read from the chunks that hold it. */
  private slice(streamId: string, start: number, end: number): string {
    const rows: StreamChunk[] = [];
    for (const row of this.statement(
      "SELECT offset, bytes FROM item_source_chunks WHERE stream_id = ? AND offset > ? AND offset < ? ORDER BY offset",
    ).iterate(streamId, start - 65536, end))
      rows.push({ offset: Number(row.offset), bytes: row.bytes as Uint8Array });
    return sliceByteRows(rows, start, end);
  }
  read(id: string): Item {
    const item = this.preview(id)?.item;
    if (!item) throw new Error("Missing item preview");
    return this.fill(
      item,
      (source) => this.size(source),
      (streamId, start, end) => this.slice(streamId, start, end),
    );
  }
  /** A stored preview row fetched in batch, parsed exactly as `preview` parses it. */
  previewFromRow(row: { item: unknown; target: unknown; created_seq: unknown }): {
    item: Item;
    target: unknown;
  } {
    const created = row.created_seq === null ? Number.NEGATIVE_INFINITY : Number(row.created_seq);
    return { item: storedItem(created, String(row.item), this.trust), target: row.target };
  }
  /**
   * `read` from prefetched rows: `preview` is the batch's preview row (or undefined when the
   * id had none), `sizes` maps stream id to its whole length, `byteRows` maps stream id to
   * its chunk rows in offset order. Slicing, surrogate handling and `remaining` match `read`.
   */
  readBatched(
    id: string,
    preview: { item: unknown; target: unknown; created_seq: unknown } | undefined,
    sizes: Map<string, unknown>,
    byteRows: Map<string, { offset: number; bytes: Uint8Array }[]>,
  ): Item {
    const stored = preview ? this.previewFromRow(preview) : undefined;
    if (!stored) throw new Error("Missing item preview");
    const sizeOf = (source: TextSource): number => StreamSize.parse(sizes.get(source.streamId));
    const slice = (streamId: string, start: number, end: number): string =>
      sliceByteRows(byteRows.get(streamId) ?? [], start, end);
    return this.fill(stored.item, sizeOf, slice);
  }
}
