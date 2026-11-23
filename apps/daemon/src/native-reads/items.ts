import { nativeHandle } from "@ace/provider-kit/sqlite";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { Item, ItemsPage, OmittedItem, ThreadId } from "@ace/protocol";
import { ItemId } from "@ace/protocol";
import { inRootLane, retainedTail } from "@ace/projection";
import { z } from "zod";
import { ItemPageCapacityExceeded } from "../item-page-capacity.ts";
import { decodeStoredItem, type StoredTrust } from "../stored-decode.ts";

/**
 * Phase 1b's native item reads (docs/store/porting-guide.md): the loaders' SQL and shaping run
 * in Rust on the store's own connection and come back as one JSON string. Rows below the trust
 * floor come back marked and are decoded here with the existing lenient decoder.
 */
interface ItemsBinding {
  itemsWirePage(
    threadId: string,
    before: number,
    limit: number,
    byteLimit: number,
    trust: { trustFrom: number | undefined; rejected: number[] },
  ): string;
  itemsPage(
    threadId: string,
    before: number,
    limit: number,
    byteLimit: number | undefined,
    trust: { trustFrom: number | undefined; rejected: number[] },
  ): string;
  itemsWindow(
    threadId: string,
    aroundSeq: number,
    before: number,
    after: number,
    byteLimit: number,
    trust: { trustFrom: number | undefined; rejected: number[] },
  ): string;
  itemsTailRows(
    threadId: string,
    kept: { id: string; seq: number }[],
    before: number | undefined,
    preview: boolean,
    rows: string,
    trust: { trustFrom: number | undefined; rejected: number[] },
  ): string;
}

function binding(db: DatabaseSync): ItemsBinding {
  const handle = nativeHandle(db) as Partial<ItemsBinding> | undefined;
  if (!handle || typeof handle.itemsWirePage !== "function")
    throw new Error("Native item reads need the phase 1b store addon");
  return handle as ItemsBinding;
}

// Tail heads, validated like the loader's own: one entry per creation sequence.
const TailHead = z.object({
  id: ItemId,
  created_seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  size: z.number().int().nonnegative(),
  agent_id: z.string(),
});

/** The native answer with its marked rows decoded, and the mark removed. */
function take<T extends { items: Item[]; untrusted: string[] }>(parsed: T): Omit<T, "untrusted"> {
  const marked = new Set(parsed.untrusted);
  const items = parsed.items.map((item) => (marked.has(item.id) ? decodeStoredItem(item) : item));
  const rest = { ...parsed, items };
  delete (rest as { untrusted?: unknown }).untrusted;
  return rest;
}

function read(
  db: DatabaseSync,
  trust: StoredTrust,
  call: (native: ItemsBinding, trust: { trustFrom: number | undefined; rejected: number[] }) => string,
): unknown {
  const target = binding(db);
  let text: string;
  try {
    text = call(target, {
      trustFrom: Number.isFinite(trust.from) ? trust.from : undefined,
      rejected: [...trust.rejected],
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("ItemPageCapacityExceeded: "))
      throw new ItemPageCapacityExceeded(error.message.slice("ItemPageCapacityExceeded: ".length));
    // The TypeScript loader decodes `undefined` as a body: reproduce its throw exactly.
    if (error instanceof Error && error.message === "AceItemsUndefinedJson") JSON.parse("undefined");
    throw error;
  }
  return JSON.parse(text);
}

export function nativeWirePage(
  db: DatabaseSync,
  trust: StoredTrust,
  threadId: ThreadId,
  before: number,
  limit: number,
  byteLimit: number,
): Omit<ItemsPage, "seq"> {
  return take(
    read(db, trust, (native, args) =>
      native.itemsWirePage(threadId, before, limit, byteLimit, args),
    ) as {
      threadId: ThreadId;
      items: Item[];
      itemSeqs: Record<string, number>;
      itemsBefore: number | null;
      untrusted: string[];
    },
  );
}

export function nativePage(
  db: DatabaseSync,
  trust: StoredTrust,
  threadId: ThreadId,
  before: number,
  limit: number,
  byteLimit?: number,
): Omit<ItemsPage, "seq"> {
  return take(
    read(db, trust, (native, args) =>
      native.itemsPage(threadId, before, limit, byteLimit ?? undefined, args),
    ) as {
      threadId: ThreadId;
      items: Item[];
      itemSeqs: Record<string, number>;
      itemsBefore: number | null;
      untrusted: string[];
    },
  );
}

export function nativeWindow(
  db: DatabaseSync,
  trust: StoredTrust,
  threadId: ThreadId,
  aroundSeq: number,
  before: number,
  after: number,
  byteLimit: number,
): Omit<ItemsPage, "seq"> & {
  targetSeq: number | null;
  itemsAfter: number | null;
  omitted?: OmittedItem[];
} {
  return take(
    read(db, trust, (native, args) =>
      native.itemsWindow(threadId, aroundSeq, before, after, byteLimit, args),
    ) as {
      threadId: ThreadId;
      targetSeq: number | null;
      items: Item[];
      itemSeqs: Record<string, number>;
      itemsBefore: number | null;
      itemsAfter: number | null;
      omitted?: OmittedItem[];
      untrusted: string[];
    },
  );
}

export function nativeTail(
  db: DatabaseSync,
  trust: StoredTrust,
  threadId: ThreadId,
  rootAgentId: string | undefined,
  limit: number,
  byteLimit: number,
  statement: (sql: string) => StatementSync,
): Omit<ItemsPage, "seq"> & { previewed?: string[] } {
  // Heads and lanes read like the loader's own: three indexed reads, whatever the length.
  const columns = "SELECT id, created_seq, size, agent_id FROM item_heads WHERE thread_id = ?";
  const lane = (agentId: string) =>
    statement(`${columns} AND agent_id = ? ORDER BY created_seq DESC LIMIT ?`).all(
      threadId,
      agentId,
      Math.floor(limit / 2),
    );
  const rows = [
    ...statement(`${columns} ORDER BY created_seq DESC LIMIT ?`).all(threadId, limit + 1),
    ...(rootAgentId === undefined ? [] : lane(rootAgentId)),
    ...lane(""),
  ];
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
  // Bodies and their chunks from one statement, so one snapshot: a completion committed
  // meanwhile is seen whole or not at all, as the loader's own batched read is.
  const bodies =
    "SELECT j.value AS id, 0 AS kind, i.item, i.created_seq, NULL AS seq, NULL AS field, NULL AS append " +
    "FROM json_each(?1) j JOIN items i ON i.id = j.value " +
    "UNION ALL " +
    "SELECT j.value, 1, NULL, NULL, c.seq, c.field, c.append " +
    "FROM json_each(?1) j JOIN item_text_chunks c ON c.item_id = j.value " +
    "ORDER BY 1, 2, 5";
  const kept = tail.kept.map((entry) => ({ id: entry.id, seq: entry.seq ?? 0 }));
  const union = preview
    ? []
    : [...statement(bodies).iterate(JSON.stringify(kept.map((entry) => entry.id)))];
  return take(
    read(db, trust, (native, args) =>
      native.itemsTailRows(
        threadId,
        kept.map((entry) => ({ id: entry.id, seq: entry.seq })),
        tail.before ?? undefined,
        preview,
        JSON.stringify(union),
        args,
      ),
    ) as {
      threadId: ThreadId;
      items: Item[];
      itemSeqs: Record<string, number>;
      itemsBefore: number | null;
      previewed?: string[];
      untrusted: string[];
    },
  );
}
