import type { DatabaseSync, SQLOutputValue, StatementSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { EventPayload } from "@ace/protocol";
import {
  storedEvent,
  storedItem,
  storedTextChunk,
  trustedFrom,
  untrusted,
  type StoredTrust,
} from "./stored-decode.ts";

/**
 * One batch of the idle trust pass (`stored-trust-pass.ts`, ADR 0125): which of the stored rows
 * just below the trusted boundary read the same as stored as validated.
 *
 * A sequence's rows are its event and every item, text preview, history revision and streamed
 * text chunk (`item_text_chunks`, trusted per chunk by its own sequence) written at it. Each body's size is read from SQLite's record header (`octet_length`, which loads no
 * content) before any body is loaded or any JSON function runs on it, and every load and parse
 * is charged to the batch's byte budget. A sequence whose rows together exceed the budget is
 * rejected unchecked, as is one the budget no longer fits after the first; so a batch loads at
 * most one budget of stored JSON, and SQLite parses at most that much again to find a
 * sequence's revisions.
 */

/** Events per batch at most. */
export const eventsPerBatch = 512;
/** Bytes of stored JSON a batch loads at most: about 20 ms of CPU, so live work waits about that. */
export const bytesPerBatch = 1 << 20;

type Row = Record<string, SQLOutputValue>;
const everything = trustedFrom(Number.NEGATIVE_INFINITY);
const nothing = untrusted();

/** Same value, same field order: what a trusted read gives equals what validation gives. */
function same(validated: unknown, stored: unknown): boolean {
  return (
    isDeepStrictEqual(validated, stored) && JSON.stringify(validated) === JSON.stringify(stored)
  );
}
function sameEvent(row: Row | undefined): boolean {
  if (!row) return false;
  try {
    const validated = storedEvent(row, nothing);
    const stored = storedEvent(row, everything);
    return validated.bytes === stored.bytes && same(validated.event, stored.event);
  } catch {
    return false;
  }
}
function sameItem(seq: number, json: SQLOutputValue | undefined): boolean {
  if (typeof json !== "string") return false;
  try {
    return same(storedItem(seq, json, nothing), storedItem(seq, json, everything));
  } catch {
    return false;
  }
}

/**
 * A text chunk reads the same both ways: as stored (`storedTextChunk`) and as the item store's
 * validating path decodes it (its append a JSON string, its field one `item.delta` accepts).
 */
function sameChunk(itemId: string, row: Record<string, SQLOutputValue> | undefined): boolean {
  if (!row) return false;
  try {
    const stored = storedTextChunk(row.field, row.append);
    const append: unknown = JSON.parse(String(row.append));
    if (typeof append !== "string") return false;
    const delta = EventPayload.parse({ type: "item.delta", itemId, field: row.field, append });
    return delta.type === "item.delta" && same({ field: delta.field, append }, stored);
  } catch {
    return false;
  }
}

const statements = {
  sizes:
    "SELECT seq, octet_length(payload) AS bytes FROM events WHERE seq < ? ORDER BY seq DESC LIMIT ?",
  // Called only for a payload the budget admitted; never throws on malformed JSON.
  revised: `SELECT CASE WHEN json_valid(payload) THEN json_extract(payload, '$.item.id') END AS item,
    CASE WHEN json_valid(payload) THEN json_extract(payload, '$.itemId') END AS delta
    FROM events WHERE seq = ?`,
  item: "SELECT id, octet_length(item) AS bytes FROM items WHERE created_seq = ?",
  preview: "SELECT octet_length(item) AS bytes FROM item_previews WHERE id = ?",
  revisions:
    "SELECT item_id, octet_length(item) AS bytes FROM history_item_revisions WHERE seq = ? AND item_id IN (?, ?)",
  event: "SELECT seq, id, thread_id, at, payload FROM events WHERE seq = ?",
  itemBody: "SELECT item FROM items WHERE id = ?",
  previewBody: "SELECT item FROM item_previews WHERE id = ?",
  revisionBody: "SELECT item FROM history_item_revisions WHERE item_id = ? AND seq = ?",
  chunk:
    "SELECT octet_length(field) + octet_length(append) AS bytes FROM item_text_chunks WHERE item_id = ? AND seq = ?",
  chunkBody: "SELECT field, append FROM item_text_chunks WHERE item_id = ? AND seq = ?",
  // Items whose event is gone: nothing names their revisions, so they stay validated.
  orphans:
    "SELECT created_seq AS seq FROM items WHERE created_seq >= ? AND created_seq < ? AND NOT EXISTS (SELECT 1 FROM events WHERE seq = items.created_seq)",
};
type Statements = Record<keyof typeof statements, StatementSync>;
function prepare(db: DatabaseSync): Statements {
  const prepared: Partial<Statements> = {};
  for (const [name, sql] of Object.entries(statements))
    prepared[name as keyof Statements] = db.prepare(sql);
  // Trusted: every key of `statements` was assigned above.
  return prepared as Statements;
}
const text = (value: SQLOutputValue | undefined) => (typeof value === "string" ? value : undefined);

/** The rows written at one sequence besides its event, sized without loading them. */
function rowsAt(s: Statements, seq: number) {
  const ids = s.revised.get(seq);
  const item = s.item.get(seq);
  const itemId = text(item?.id);
  const preview = itemId === undefined ? undefined : s.preview.get(itemId);
  const revisions = s.revisions.all(seq, text(ids?.item) ?? null, text(ids?.delta) ?? null);
  // A streamed chunk is written at its delta's sequence, under the item that delta names.
  const deltaId = text(ids?.delta);
  const chunk = deltaId === undefined ? undefined : s.chunk.get(deltaId, seq);
  const bytes =
    Number(item?.bytes ?? 0) +
    Number(preview?.bytes ?? 0) +
    Number(chunk?.bytes ?? 0) +
    revisions.reduce((sum, row) => sum + Number(row.bytes), 0);
  return {
    bytes,
    check(): boolean {
      if (!sameEvent(s.event.get(seq))) return false;
      if (itemId !== undefined && !sameItem(seq, s.itemBody.get(itemId)?.item)) return false;
      if (itemId !== undefined && preview && !sameItem(seq, s.previewBody.get(itemId)?.item))
        return false;
      for (const revision of revisions) {
        const id = text(revision.item_id);
        if (id === undefined || !sameItem(seq, s.revisionBody.get(id, seq)?.item)) return false;
      }
      if (deltaId !== undefined && chunk && !sameChunk(deltaId, s.chunkBody.get(deltaId, seq)))
        return false;
      return true;
    },
  };
}

/** One batch's outcome: every sequence from `from` on is confirmed, except `rejected`. */
export interface StoredTrustBatch {
  from: number;
  rejected: number[];
}

/**
 * Check the sequences just below `trust.from`: at most `limit` events, loading at most `budget`
 * bytes of stored JSON (see the module comment). Reads only. Undefined when nothing is left.
 */
export function verifyStoredBatch(
  db: DatabaseSync,
  trust: StoredTrust,
  limit = eventsPerBatch,
  budget = bytesPerBatch,
): StoredTrustBatch | undefined {
  const high = trust.from;
  if (!(high > 0)) return undefined;
  const s = prepare(db);
  const rejected = new Set<number>();
  let spent = 0;
  let low = high;
  let seen = 0;
  let full = false;
  for (const row of s.sizes.all(high, limit)) {
    const seq = Number(row.seq);
    const eventBytes = Number(row.bytes);
    seen++;
    if (eventBytes > budget) {
      rejected.add(seq);
      low = seq;
      continue;
    }
    if (spent + eventBytes > budget) {
      full = true;
      break;
    }
    // Finding the revisions parses the payload in SQLite: charged before anything else.
    spent += eventBytes;
    const rows = rowsAt(s, seq);
    if (eventBytes + rows.bytes > budget) {
      rejected.add(seq);
      low = seq;
      continue;
    }
    if (spent + rows.bytes > budget) {
      // Its own batch checks it; what this one spent finding its revisions is the only waste.
      full = true;
      break;
    }
    spent += rows.bytes;
    if (!rows.check()) rejected.add(seq);
    low = seq;
  }
  // A short page that wasn't cut by the budget reached the oldest event.
  if (!full && seen < limit) low = 0;
  if (low === high) return undefined;
  for (const row of s.orphans.all(low, high)) rejected.add(Number(row.seq));
  return { from: low, rejected: [...rejected] };
}
