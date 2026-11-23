import {
  decodeStoredItem,
  isTrusted,
  storedItem,
  storedTextChunk,
  untrusted,
  type StoredTrust,
} from "./stored-decode.ts";
import {
  ItemTextStore,
  headRange,
  sliceByteRows,
  sourcesInFillOrder,
  tailRange,
  trimLowStart,
} from "./item-text-store.ts";
import { recordSkillUsage } from "./skill-usage.ts";
import { ItemPageCapacityExceeded } from "./item-page-capacity.ts";
import { nativeReads } from "./native-reads/switch.ts";
import { NativeItemRows, TsItemRows, type ItemRows } from "./item-rows.ts";
import {
  fetchBodies,
  fetchHeadsBySeqs,
  fetchPreviews,
  fetchStreamBytes,
  fetchStreamSizes,
  groupBodyRows,
  type PreviewRow,
} from "./native-reads/items.ts";
import { boundedItemPage } from "./bounded-item-page.ts";
import { z } from "zod";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  EventPayload,
  Item,
  ItemId,
  type Event,
  type ItemsPage,
  type OmittedItem,
  RawPayload,
  type TextSource,
  type ThreadId,
} from "@ace/protocol";
import { applyDelta, inRootLane, retainedTail } from "@ace/projection";

// Item head rows, built once: Zod compiles a parser per schema object, and pages are per request.
const createdSeq = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const WirePageRows = z
  .array(
    z.object({
      id: ItemId,
      created_seq: createdSeq,
      size: z.number().int().nonnegative(),
      // Only text previews are special-cased below; any other item type, including ones
      // added after this reader, pages by its stored size.
      item_type: z.string().min(1).max(64),
    }),
  )
  .max(201);
const NewestHead = z.object({
  id: ItemId,
  created_seq: createdSeq,
  item_type: z.string().min(1).max(64),
});
const TailHead = z.object({
  id: ItemId,
  created_seq: createdSeq,
  size: z.number().int().nonnegative(),
  agent_id: z.string(),
});

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
/**
 * An item's raw payloads from an index, oldest first (`rawEntries`): `json_each` yields array
 * elements in order, so there is no sort or temporary b-tree, and the caller stops stepping once
 * its page is full. What still grows with the item: SQLite parses the stored item JSON and walks
 * the array's elements up to `from` (in C, no rows returned) before the first one comes back.
 */
export const rawEntriesQuery =
  "SELECT e.value AS value, e.type AS type FROM items i, json_each(i.item, ?) e WHERE i.id = ? AND i.thread_id = ? AND e.key >= ?";

export class ItemStore {
  private readonly texts: ItemTextStore;
  private readonly db: DatabaseSync;
  private readonly statement: (sql: string) => StatementSync;
  private readonly trust: StoredTrust;
  /** The leaf reads the loaders call: today's statements, or the same reads as Rust batches. */
  private readonly rows: ItemRows;
  /**
   * The window's primed rows while its add loop runs: bodies, previews, sizes and bytes for
   * the jump point and neighbors, fetched in the loop's order before it starts. `wirePage`
   * serves its single-item calls from here and falls back to the data source otherwise.
   */
  private windowCache:
    | {
        threadId: ThreadId;
        heads: Map<number, { id: string; created_seq: number; size: number; item_type: string }>;
        bodies: Map<string, { item: unknown; created_seq: unknown }>;
        chunks: Map<string, { seq: unknown; field: unknown; append: unknown }[]>;
        previews: Map<string, PreviewRow>;
        sizes: Map<string, unknown>;
        byteRows: Map<string, { offset: number; bytes: Uint8Array }[]>;
      }
    | undefined;
  constructor(
    db: DatabaseSync,
    statement: (sql: string) => StatementSync,
    trust: StoredTrust = untrusted(),
  ) {
    this.statement = statement;
    this.db = db;
    this.rows = nativeReads("items") ? new NativeItemRows(db) : new TsItemRows(statement);
    this.texts = new ItemTextStore(db, trust);
    this.trust = trust;
  }
  /** Rebuild encoding metadata once after migration, recovering old chunks from the event log. */
  initialize(): void {
    if (this.statement("SELECT id FROM text_encoding_migration WHERE id = 1").get()) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of this.statement("SELECT id, item FROM items").iterate()) {
        const item = decodeStoredItem(JSON.parse(String(row.item)));
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
    // `raw_seq`: this write's sequence. Only an upsert rewrites an item's raw payloads (a delta
    // changes its text or output), so it names their version (`rawRevision`).
    this.statement(`INSERT INTO item_heads (id, thread_id, created_seq, size, item_type, text_prefix, text_last_unit, agent_id, raw_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET size = excluded.size, item_type = excluded.item_type, text_prefix = excluded.text_prefix, text_last_unit = excluded.text_last_unit, raw_seq = excluded.raw_seq`).run(
      item.id,
      event.threadId,
      event.seq,
      Buffer.byteLength(body),
      item.type,
      prefix,
      lastUnit,
      item.agentId ?? "",
      event.seq,
    );
    this.statement("DELETE FROM item_text_chunks WHERE item_id = ?").run(item.id);
    recordSkillUsage((sql) => this.statement(sql), event.threadId, item);
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
  /** A missing row keeps the old behaviour: decoding `undefined` throws. */
  private materializeRow(id: string, row: Record<string, unknown> | undefined): Item {
    return this.materialize(id, row?.item, row?.created_seq);
  }
  /**
   * `created` (the item's creation sequence) decides whether this build wrote the body (see
   * `storedItem`); each text chunk is trusted by its own sequence the same way.
   */
  private materialize(id: string, body: unknown, created: unknown): Item {
    // Stream rows instead of retaining their objects.
    return this.withChunks(
      storedItem(Number(created), String(body), this.trust),
      this.statement(
        "SELECT seq, field, append FROM item_text_chunks WHERE item_id = ? ORDER BY seq",
      ).iterate(id),
    );
  }
  /** `item` with its unmerged text chunks, in sequence order, applied. */
  private withChunks(item: Item, chunks: Iterable<Record<string, unknown>>): Item {
    let field: unknown;
    // Set from the first chunk when every chunk is trusted: the field `applyDelta` takes as is.
    let trustedField: ReturnType<typeof storedTextChunk>["field"] | undefined;
    let trusted = true;
    const appends: string[] = [];
    // Accepted fields share one append target.
    for (const row of chunks) {
      field ??= row.field;
      if (isTrusted(this.trust, Number(row.seq))) {
        const chunk = storedTextChunk(row.field, row.append);
        trustedField ??= chunk.field;
        appends.push(chunk.append);
      } else {
        trusted = false;
        appends.push(decodeAppend(row.append));
      }
    }
    if (!appends.length) return item;
    if (trusted && trustedField) {
      applyDelta(item, trustedField, appends.join(""));
      return item;
    }
    const delta = EventPayload.parse({
      type: "item.delta",
      itemId: item.id,
      agentId: item.agentId,
      field,
      append: appends.join(""),
    });
    if (delta.type !== "item.delta") throw new Error("Invalid text delta");
    applyDelta(item, delta.field, delta.append);
    return item;
  }
  /**
   * Whole items by id, each as `materialize` gives it. Bodies and their chunks come from one
   * statement, so from one snapshot: a completion committed meanwhile (which folds the chunks
   * into the body and deletes them) is seen whole or not at all. An id with no body throws.
   */
  private materializeAll(ids: readonly string[]): Map<string, Item> {
    const bodies = new Map<string, Record<string, unknown>>();
    const chunks = new Map<string, Record<string, unknown>[]>();
    // Each item's body row (kind 0) comes before its chunks (kind 1), in sequence order. One
    // snapshot is enough because a completion writes the body and deletes its chunks atomically.
    for (const row of this.statement(
      `SELECT j.value AS id, 0 AS kind, i.item, i.created_seq, NULL AS seq, NULL AS field, NULL AS append
         FROM json_each(?1) j JOIN items i ON i.id = j.value
       UNION ALL
       SELECT j.value, 1, NULL, NULL, c.seq, c.field, c.append
         FROM json_each(?1) j JOIN item_text_chunks c ON c.item_id = j.value
       ORDER BY 1, 2, 5`,
    ).iterate(JSON.stringify(ids))) {
      const id = String(row.id);
      if (row.kind === 0) bodies.set(id, row);
      else {
        const rows = chunks.get(id);
        if (rows) rows.push(row);
        else chunks.set(id, [row]);
      }
    }
    const items = new Map<string, Item>();
    for (const id of ids) {
      const row = bodies.get(id);
      if (!row) throw new Error("Missing item body");
      items.set(
        id,
        this.withChunks(
          storedItem(Number(row.created_seq), String(row.item), this.trust),
          chunks.get(id) ?? [],
        ),
      );
    }
    return items;
  }
  wirePage(
    threadId: ThreadId,
    before: number,
    limit: number,
    byteLimit: number,
  ): Omit<ItemsPage, "seq"> {
    // A window's add loop serves its single-item reads from primed rows; anything else the
    // loop asks for falls back to the data source below, exactly as its own page would.
    const cached =
      nativeReads("items") && this.windowCache?.threadId === threadId && limit === 1
        ? this.windowCache.heads.get(before - 1)
        : undefined;
    if (cached) return this.wirePageSingle(threadId, cached, byteLimit);
    const rows = this.rows.wireHeads(threadId, before, limit + 1);
    const decoded = WirePageRows.parse(rows);
    const take = decoded.slice(0, limit);
    // Native priming, after the loop's own head pre-check below has chosen which bodies it
    // will read: one batched read per table for the chosen prefix, never earlier. Previews
    // accumulate nothing here (their measured size is unknown until read), so the prefix can
    // only overshoot the stored-size break, never undershoot it; anything the loop still
    // needs faults in on demand through the same statements.
    const primed = (() => {
      if (!nativeReads("items") || this.windowCache) return undefined;
      const wanted = ItemStore.selectTake(take, byteLimit);
      const kinds = new Map(wanted.map((head) => [String(head.id), head.item_type]));
      return this.primeIds(
        wanted.map((head) => String(head.id)),
        kinds,
      );
    })();
    const items: Item[] = [];
    const cursors: [string, number][] = [];
    let bytes = 512;
    for (const row of take) {
      const id = String(row.id);
      const out = this.pageOne(
        row,
        bytes,
        byteLimit,
        items.length === 0,
        () => (primed ? this.assemblePrimed(primed, id, row.item_type) : undefined),
        () => this.pageItem(id, row.item_type),
      );
      if ("done" in out) break;
      items.push(out.item);
      cursors.push([id, Number(row.created_seq)]);
      bytes += out.size;
    }
    items.reverse();
    return {
      threadId,
      items,
      itemSeqs: Object.fromEntries(cursors),
      itemsBefore: rows.length > items.length ? (cursors.at(-1)?.[1] ?? before) : null,
    };
  }
  private static isPreviewType(type: string): boolean {
    return type === "message" || type === "notice" || type === "reasoning";
  }
  /**
   * The head pre-check the output loop runs before loading a body: non-preview items larger
   * than the remaining budget stop the page here, without their body ever being read. Shared
   * by the loop and by priming so the two cannot diverge.
   */
  private static preFits(
    bytes: number,
    size: number,
    itemType: string,
    overhead: number,
    byteLimit: number,
  ): boolean {
    return ItemStore.isPreviewType(itemType) || bytes + size + overhead <= byteLimit;
  }
  /**
   * One wire-page item, exactly as the output loop reads it: the shared pre-check, the load,
   * then the measured full check. Returns the item and its budgeted size, `done` when the
   * page ends here, and throws the page's capacity error when it cannot even start.
   */
  private pageOne(
    head: { id: unknown; created_seq: unknown; size: unknown; item_type: string },
    bytes: number,
    byteLimit: number,
    empty: boolean,
    load: () => Item | undefined,
    fallback: () => Item,
  ): { item: Item; size: number } | { done: "break" } {
    const id = String(head.id);
    const overhead = Buffer.byteLength(JSON.stringify(id)) + 64;
    const preview = ItemStore.isPreviewType(head.item_type);
    const fail = (): { done: "break" } => {
      if (empty) throw new ItemPageCapacityExceeded("Item detail exceeds page capacity");
      return { done: "break" };
    };
    // The authoritative encoded size is already persisted by the payload owner.
    // Tool/artifact details have no smaller wire preview: reject them before
    // loading their body into JS, parsing it, or allocating its serialized copy.
    // Text items instead carry bounded previews and separate full-text sources.
    if (!ItemStore.preFits(bytes, Number(head.size), head.item_type, overhead, byteLimit))
      return fail();
    const item = load() ?? fallback();
    // A body this build wrote is read as stored and takes no text chunks, so its stored size
    // is exactly its JSON's. Text previews and older bodies are measured.
    const size =
      (!preview && isTrusted(this.trust, Number(head.created_seq))
        ? Number(head.size)
        : Buffer.byteLength(JSON.stringify(item))) + overhead;
    if (bytes + size > byteLimit) return fail();
    return { item, size };
  }
  /**
   * The output loop's own head pre-check, run over the take list to choose which bodies to
   * fetch: the prefix that passes with stored sizes. Previews accumulate nothing here (their
   * measured size is unknown until read), so the prefix can only overshoot what the loop
   * keeps, never undershoot it for stored sizes; anything the loop still needs faults in on
   * demand through the same statements.
   */
  private static selectTake<T extends { id: unknown; item_type: string; size: unknown }>(
    take: readonly T[],
    byteLimit: number,
  ): T[] {
    const wanted: T[] = [];
    let bytes = 512;
    for (const head of take) {
      const overhead = Buffer.byteLength(JSON.stringify(String(head.id))) + 64;
      if (!ItemStore.preFits(bytes, Number(head.size), head.item_type, overhead, byteLimit)) break;
      wanted.push(head);
      if (!ItemStore.isPreviewType(head.item_type)) bytes += Number(head.size) + overhead;
    }
    return wanted;
  }
  /** Rows primed for one output loop: bodies, previews, sizes and bytes by id. */
  private primeIds(
    ids: readonly string[],
    kinds: Map<string, string>,
  ): {
    bodies: Map<string, { item: unknown; created_seq: unknown }>;
    chunks: Map<string, { seq: unknown; field: unknown; append: unknown }[]>;
    previews: Map<string, PreviewRow>;
    sizes: Map<string, unknown>;
    byteRows: Map<string, { offset: number; bytes: Uint8Array }[]>;
  } {
    const bodyIds = ids.filter((id) => !ItemStore.isPreviewType(kinds.get(id) ?? ""));
    const previewIds = ids.filter((id) => ItemStore.isPreviewType(kinds.get(id) ?? ""));
    const grouped = groupBodyRows(fetchBodies(this.db, bodyIds));
    const previews = new Map<string, PreviewRow>();
    for (const row of fetchPreviews(this.db, previewIds)) previews.set(String(row.id), row);
    const { sizes, byteRows } = this.primePreviewBytes([...previews.values()]);
    return { bodies: grouped.bodies, chunks: grouped.chunks, previews, sizes, byteRows };
  }
  /**
   * Sizes and bytes for batched previews, in the order `fill` reads them: sizes for every
   * source first, then bytes round by round, one round per text part, so each range matches
   * the remaining allowance the fill will have. Single-source previews take exactly two calls.
   */
  private primePreviewBytes(previewRows: PreviewRow[]): {
    sizes: Map<string, unknown>;
    byteRows: Map<string, { offset: number; bytes: Uint8Array }[]>;
  } {
    const parsed = new Map<string, { item: Item; streaming: boolean }>();
    for (const row of previewRows) {
      const item = this.texts.previewFromRow({
        item: row.item,
        target: row.target,
        created_seq: row.created_seq,
      }).item;
      parsed.set(String(row.id), { item, streaming: !item.complete });
    }
    const order = new Map<string, TextSource[]>();
    const streamIds: string[] = [];
    const seen = new Set<string>();
    for (const [id, entry] of parsed) {
      const sources = sourcesInFillOrder(entry.item);
      order.set(id, sources);
      for (const source of sources)
        if (!seen.has(source.streamId)) {
          seen.add(source.streamId);
          streamIds.push(source.streamId);
        }
    }
    const sizes = new Map<string, unknown>();
    for (const row of fetchStreamSizes(this.db, streamIds)) sizes.set(String(row.id), row.size);
    const byteRows = new Map<string, { offset: number; bytes: Uint8Array }[]>();
    const remaining = new Map<string, number>();
    const position = new Map<string, number>();
    for (const id of parsed.keys()) {
      remaining.set(id, 4096);
      position.set(id, 0);
    }
    for (;;) {
      const ranges: { id: string; start: number; end: number }[] = [];
      const pending: { id: string; streamId: string; start: number; end: number }[] = [];
      for (const [id, entry] of parsed) {
        const sources = order.get(id) ?? [];
        const at = position.get(id) ?? sources.length;
        if (at >= sources.length) continue;
        const source = sources[at];
        if (!source) continue;
        const size = sizes.get(source.streamId);
        // A missing size throws in the fill, exactly as its single read does.
        if (size === undefined) {
          position.set(id, sources.length);
          continue;
        }
        const numericSize = Number(size);
        const rem = remaining.get(id) ?? 4096;
        const [start, end] = entry.streaming
          ? tailRange(numericSize, rem)
          : headRange(numericSize, rem);
        ranges.push({ id: source.streamId, start, end });
        pending.push({ id, streamId: source.streamId, start, end });
      }
      if (!pending.length) break;
      if (ranges.length)
        for (const row of fetchStreamBytes(this.db, ranges)) {
          const streamId = String(row.stream_id);
          const entry = { offset: Number(row.offset), bytes: row.bytes as Uint8Array };
          const list = byteRows.get(streamId);
          if (list) list.push(entry);
          else byteRows.set(streamId, [entry]);
        }
      for (const step of pending) {
        const text = trimLowStart(
          sliceByteRows(byteRows.get(step.streamId) ?? [], step.start, step.end),
          step.start,
        ).text;
        remaining.set(step.id, (remaining.get(step.id) ?? 4096) - text.length);
        position.set(step.id, (position.get(step.id) ?? 0) + 1);
      }
    }
    return { sizes, byteRows };
  }
  /**
   * Prime the rows the window's add loop will read, in its order: heads for the decided
   * jump point and neighbors, then the prefix its own pre-check chooses, then exact preview
   * bytes. The add loop itself is unchanged and stops where it always did; anything beyond
   * the prefix faults in through the data source.
   */
  private primeWindow(
    threadId: ThreadId,
    targetSeq: number,
    older: number[],
    newer: number[],
    byteLimit: number,
  ): void {
    const heads = new Map<
      number,
      { id: string; created_seq: number; size: number; item_type: string }
    >();
    for (const row of fetchHeadsBySeqs(this.db, threadId, [targetSeq, ...older, ...newer])) {
      const seq = Number(row.created_seq);
      heads.set(seq, {
        id: String(row.id),
        created_seq: seq,
        size: Number(row.size),
        item_type: String(row.item_type),
      });
    }
    const order: number[] = [targetSeq];
    for (let i = 0; i < Math.max(older.length, newer.length); i++) {
      const old = older[i];
      if (old !== undefined) order.push(old);
      const next = newer[i];
      if (next !== undefined) order.push(next);
    }
    const kinds = new Map<string, string>();
    const ids: string[] = [];
    let bytes = 512;
    for (const seq of order) {
      const head = heads.get(seq);
      if (!head) break;
      const overhead = Buffer.byteLength(JSON.stringify(head.id)) + 64;
      if (!ItemStore.preFits(bytes, head.size, head.item_type, overhead, byteLimit)) break;
      ids.push(head.id);
      kinds.set(head.id, head.item_type);
      if (!ItemStore.isPreviewType(head.item_type)) bytes += head.size + overhead;
    }
    const primed = this.primeIds(ids, kinds);
    this.windowCache = { threadId, heads, ...primed };
  }
  /** A primed item, or undefined when the loop must read it through the data source. */
  private assemblePrimed(
    cache: {
      bodies: Map<string, { item: unknown; created_seq: unknown }>;
      chunks: Map<string, { seq: unknown; field: unknown; append: unknown }[]>;
      previews: Map<string, PreviewRow>;
      sizes: Map<string, unknown>;
      byteRows: Map<string, { offset: number; bytes: Uint8Array }[]>;
    },
    id: string,
    type: string,
  ): Item | undefined {
    if (ItemStore.isPreviewType(type)) {
      const row = cache.previews.get(id);
      if (!row) return undefined;
      return this.texts.readBatched(id, row, cache.sizes, cache.byteRows);
    }
    const body = cache.bodies.get(id);
    if (!body) return undefined;
    return this.withChunks(
      storedItem(Number(body.created_seq), String(body.item), this.trust),
      (cache.chunks.get(id) ?? []).map((row) => ({
        seq: row.seq,
        field: row.field,
        append: row.append,
      })),
    );
  }
  /** One wire-page item served from a window's primed rows, measured exactly as its page. */
  private wirePageSingle(
    threadId: ThreadId,
    head: { id: string; created_seq: number; size: number; item_type: string },
    byteLimit: number,
  ): Omit<ItemsPage, "seq"> {
    const validated = WirePageRows.parse([head]);
    const row = validated[0];
    if (!row) throw new Error("Invalid item page");
    const id = String(row.id);
    const cache = this.windowCache;
    const out = this.pageOne(
      row,
      512,
      byteLimit,
      true,
      () => (cache ? this.assemblePrimed(cache, id, row.item_type) : undefined),
      () => this.pageItem(id, row.item_type),
    );
    if ("done" in out) throw new ItemPageCapacityExceeded("Item detail exceeds page capacity");
    return {
      threadId,
      items: [out.item],
      itemSeqs: { [id]: Number(row.created_seq) },
      itemsBefore: null,
    };
  }
  /** An item as a page shows it: text cut to its bounded preview, other bodies whole. */
  private pageItem(id: string, type: string): Item {
    return type === "message" || type === "notice" || type === "reasoning"
      ? this.texts.read(id)
      : this.materializeRow(
          id,
          this.statement("SELECT item, created_seq FROM items WHERE id = ?").get(id),
        );
  }
  /** The newest item created before `before`, as a page shows it, with its creation cursor. */
  newestBefore(threadId: ThreadId, before: number): { item: Item; seq: number } | undefined {
    const row = this.statement(
      "SELECT id, created_seq, item_type FROM item_heads WHERE thread_id = ? AND created_seq < ? ORDER BY created_seq DESC LIMIT 1",
    ).get(threadId, before);
    if (!row) return undefined;
    const head = NewestHead.parse(row);
    return { item: this.pageItem(String(head.id), head.item_type), seq: head.created_seq };
  }
  hasItemBefore(threadId: ThreadId, before: number): boolean {
    return (
      this.statement(
        "SELECT 1 FROM item_heads WHERE thread_id = ? AND created_seq < ? LIMIT 1",
      ).get(threadId, before) !== undefined
    );
  }
  private fitsAlone(threadId: ThreadId, seq: number, byteLimit: number): boolean {
    try {
      this.wirePage(threadId, seq + 1, 1, byteLimit);
      return true;
    } catch (error) {
      if (error instanceof ItemPageCapacityExceeded) return false;
      throw error;
    }
  }
  /** The item at `seq`, reduced to fit `byteLimit`, or an omission marker alone. */
  private reducedPage(threadId: ThreadId, seq: number, byteLimit: number) {
    return boundedItemPage(
      {
        page: (from, count, limit) => this.wirePage(threadId, from, count, limit),
        newestBefore: (from) => this.newestBefore(threadId, from),
        hasItemBefore: (from) => this.hasItemBefore(threadId, from),
      },
      threadId,
      seq + 1,
      1,
      byteLimit,
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
    const row = this.statement(
      "SELECT item, created_seq FROM items WHERE id = ? AND thread_id = ?",
    ).get(itemId, threadId);
    return row ? this.materialize(itemId, row.item, row.created_seq) : undefined;
  }
  /**
   * Which version of an item's raw payloads is stored: its creation and the write that last
   * replaced its body, read from its head row alone. Undefined without the item. A row from
   * before `raw_seq` holds 0 there: its body was last written at its creation.
   */
  rawRevision(threadId: ThreadId, itemId: string): string | undefined {
    const row = this.statement(
      "SELECT created_seq, CASE raw_seq WHEN 0 THEN created_seq ELSE raw_seq END AS raw_seq FROM item_heads WHERE id = ? AND thread_id = ?",
    ).get(itemId, threadId);
    return row ? `${Number(row.created_seq)}.${Number(row.raw_seq)}` : undefined;
  }
  /**
   * An item's raw payloads (a tool call's `call.raw`) from index `from`, read one at a time
   * as the caller takes them: SQLite walks the stored JSON, and only the entries taken are
   * decoded here. Each is read leniently: one that is not a raw payload comes as its data.
   */
  *rawEntries(threadId: ThreadId, itemId: string, from: number): Generator<RawPayload> {
    const head = this.statement(
      "SELECT item_type FROM item_heads WHERE id = ? AND thread_id = ?",
    ).get(itemId, threadId);
    if (!head) return;
    const path = head.item_type === "tool_call" ? "$.call.raw" : "$.raw";
    for (const row of this.statement(rawEntriesQuery).iterate(path, itemId, threadId, from)) {
      const value: unknown =
        row.type === "object" || row.type === "array" ? JSON.parse(String(row.value)) : row.value;
      const parsed = RawPayload.safeParse(value);
      yield parsed.success ? parsed.data : { type: "unreadable", data: value };
    }
  }
  createdSeq(threadId: ThreadId, itemId: string): number | undefined {
    const row = this.statement("SELECT created_seq FROM item_heads WHERE thread_id=? AND id=?").get(
      threadId,
      itemId,
    );
    return row ? Number(row.created_seq) : undefined;
  }
  window(threadId: ThreadId, aroundSeq: number, before: number, after: number, byteLimit: number) {
    const targetSeq = this.rows.windowTarget(threadId, aroundSeq);
    if (targetSeq === null)
      return {
        threadId,
        targetSeq: null,
        items: [],
        itemSeqs: {},
        itemsBefore: null,
        itemsAfter: null,
      };
    const neighbors = this.rows.windowNeighbors(threadId, targetSeq, before, after);
    const older = neighbors.older;
    const newer = neighbors.newer;
    // Native priming, in the add loop's order below: heads for the decided jump point and
    // neighbors, then the prefix its own pre-check chooses, then exact preview bytes. The
    // add loop itself is unchanged and stops where it always did; anything beyond the
    // prefix faults in through the data source.
    if (nativeReads("items")) this.primeWindow(threadId, targetSeq, older, newer, byteLimit);
    try {
      const selected = new Map<number, Item>();
      const omitted: OmittedItem[] = [];
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
          if (!(error instanceof ItemPageCapacityExceeded)) throw error;
          // A neighbor that fits a window of its own waits for the next one.
          if (seq !== targetSeq && this.fitsAlone(threadId, seq, byteLimit)) return false;
          // Larger than any window: it comes reduced to an eighth of one, leaving room for its
          // neighbors, so a window that starts at it still reaches older items.
          page = this.reducedPage(threadId, seq, Math.min(byteLimit - bytes, byteLimit / 8) + 512);
          if (!page.items[0]) {
            if (seq === targetSeq) throw error;
            return false;
          }
        }
        const item = page.items[0];
        if (!item) return false;
        const size =
          Buffer.byteLength(JSON.stringify(item)) + Buffer.byteLength(JSON.stringify(item.id)) + 64;
        const marks = page.omitted ?? [];
        bytes += size + (marks.length ? Buffer.byteLength(JSON.stringify(marks)) : 0);
        omitted.push(...marks);
        selected.set(seq, item);
        return true;
      };
      if (!add(targetSeq)) throw new Error("Item detail exceeds window capacity");
      // Alternate sides until the budget is reached, preserving one contiguous interval.
      let left = 0,
        right = 0;
      while (left < older.length || right < newer.length) {
        const old = older[left];
        if (old !== undefined) {
          if (!add(old)) break;
          left++;
        }
        const next = newer[right];
        if (next !== undefined) {
          if (!add(next)) break;
          right++;
        }
      }
      const entries = [...selected].toSorted((a, b) => a[0] - b[0]);
      const first = entries[0]?.[0] ?? targetSeq,
        last = entries.at(-1)?.[0] ?? targetSeq;
      const existence = this.rows.windowExistence(threadId, first, last);
      return {
        threadId,
        targetSeq,
        items: entries.map(([, item]) => item),
        itemSeqs: Object.fromEntries(entries.map(([seq, item]) => [item.id, seq])),
        itemsBefore: existence.hasBefore ? first : null,
        itemsAfter: existence.hasAfter ? last : null,
        ...(omitted.length ? { omitted: omitted.toSorted((a, b) => a.seq - b.seq) } : {}),
      };
    } finally {
      this.windowCache = undefined;
    }
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
  ): Omit<ItemsPage, "seq"> & { previewed?: string[] } {
    // Heads through the data source (one call native, three indexed reads back to back);
    // everything below is the loader unchanged, including the single-statement bodies read
    // the concurrent-completion test hooks.
    const rows = this.rows.tailHeads(threadId, rootAgentId, limit);
    const heads = new Map<number, z.infer<typeof TailHead>>();
    // The bound follows `limit`; the element schema is the shared, compiled `TailHead`.
    // oxlint-disable-next-line ace/zod-schema-in-function -- wraps a module-level schema
    for (const row of z
      .array(TailHead)
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
    const whole = preview ? undefined : this.materializeAll(tail.kept.map((entry) => entry.id));
    const kept = tail.kept.flatMap((entry) => {
      const item = whole ? whole.get(entry.id) : this.stepItem(threadId, entry.id);
      return item ? [{ item, seq: entry.seq ?? 0 }] : [];
    });
    return {
      threadId,
      items: kept.map((entry) => entry.item),
      itemSeqs: Object.fromEntries(kept.map((entry) => [entry.item.id, entry.seq])),
      itemsBefore: tail.before ?? null,
      ...(preview && kept[0] ? { previewed: [kept[0].item.id] } : {}),
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
    const rows = this.rows.pageHeads(threadId, before, limit + 1);
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
        ? (() => {
            const bodies = this.rows.rangeBodies(threadId, oldest, before);
            const chunks = new Map<string, { seq: unknown; field: unknown; append: unknown }[]>();
            for (const row of this.rows.chunksFor(bodies.map((body) => String(body.id)))) {
              const key = String(row.item_id);
              const list = chunks.get(key);
              const entry = { seq: row.seq, field: row.field, append: row.append };
              if (list) list.push(entry);
              else chunks.set(key, [entry]);
            }
            return bodies.map((row) =>
              this.withChunks(
                storedItem(Number(row.created_seq), String(row.item), this.trust),
                chunks.get(String(row.id)) ?? [],
              ),
            );
          })()
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
