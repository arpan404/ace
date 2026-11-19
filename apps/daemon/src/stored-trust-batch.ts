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
import { chunkRow, revisionRow, storedTrustRowsComplete } from "./stored-trust-rows.ts";

/**
 * One batch of the idle trust pass (`stored-trust-pass.ts`, ADR 0125): which of the stored rows
 * just below the trusted boundary read the same as stored as validated.
 *
 * A sequence is trusted for every row a read trusts by that sequence, so a batch enumerates
 * those rows by the sequence itself, never by what the event at it names: the event, the item
 * created at it and that item's text preview, every history revision at it and every streamed
 * text chunk at it, whichever item they belong to, the last two through the map of rows by
 * sequence (`stored-trust-rows.ts`), so a batch checks nothing until that map is complete. A sequence where any of them differs is
 * rejected, as is one that has such rows but no event. Each body's size is read from SQLite's
 * record header (`octet_length`, which loads no content) before it is loaded, and every load is
 * charged to the batch's byte budget: a sequence whose rows together exceed it is rejected
 * unchecked, and a batch stops where the next sequence no longer fits, so it loads at most one
 * budget of stored JSON.
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
  item: "SELECT id, octet_length(item) AS bytes FROM items WHERE created_seq = ?",
  preview: "SELECT octet_length(item) AS bytes FROM item_previews WHERE id = ?",
  // The map of rows by sequence (`stored-trust-rows.ts`) finds them; the join reads their sizes.
  revisions: `SELECT r.item_id, octet_length(r.item) AS bytes FROM stored_trust_rows m
    JOIN history_item_revisions r ON r.item_id = m.item_id AND r.seq = m.seq
    WHERE m.seq = ? AND m.kind = ${revisionRow}`,
  chunks: `SELECT c.item_id, octet_length(c.field) + octet_length(c.append) AS bytes FROM stored_trust_rows m
    JOIN item_text_chunks c ON c.item_id = m.item_id AND c.seq = m.seq
    WHERE m.seq = ? AND m.kind = ${chunkRow}`,
  event: "SELECT seq, id, thread_id, at, payload FROM events WHERE seq = ?",
  itemBody: "SELECT item FROM items WHERE id = ?",
  previewBody: "SELECT item FROM item_previews WHERE id = ?",
  revisionBody: "SELECT item FROM history_item_revisions WHERE item_id = ? AND seq = ?",
  chunkBody: "SELECT field, append FROM item_text_chunks WHERE item_id = ? AND seq = ?",
  // Rows at a sequence with no event: nothing names them, so they stay validated.
  orphans: `SELECT created_seq AS seq FROM items WHERE created_seq >= ?1 AND created_seq < ?2
      AND NOT EXISTS (SELECT 1 FROM events WHERE seq = items.created_seq)
    UNION SELECT seq FROM stored_trust_rows m WHERE seq >= ?1 AND seq < ?2
      AND NOT EXISTS (SELECT 1 FROM events WHERE seq = m.seq)`,
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

/** Every row written at one sequence besides its event, sized without loading them. */
function rowsAt(s: Statements, seq: number) {
  const item = s.item.get(seq);
  const itemId = text(item?.id);
  const preview = itemId === undefined ? undefined : s.preview.get(itemId);
  const revisions = s.revisions.all(seq);
  const chunks = s.chunks.all(seq);
  const bytes =
    Number(item?.bytes ?? 0) +
    Number(preview?.bytes ?? 0) +
    [...revisions, ...chunks].reduce((sum, row) => sum + Number(row.bytes), 0);
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
      for (const chunk of chunks) {
        const id = text(chunk.item_id);
        if (id === undefined || !sameChunk(id, s.chunkBody.get(id, seq))) return false;
      }
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
 * bytes of stored JSON (see the module comment). Reads only. Undefined when nothing is left, or
 * while the map of rows by sequence is still being filled.
 */
export function verifyStoredBatch(
  db: DatabaseSync,
  trust: StoredTrust,
  limit = eventsPerBatch,
  budget = bytesPerBatch,
): StoredTrustBatch | undefined {
  const high = trust.from;
  if (!(high > 0) || !storedTrustRowsComplete(db)) return undefined;
  const s = prepare(db);
  const rejected = new Set<number>();
  let spent = 0;
  let low = high;
  let seen = 0;
  let full = false;
  for (const row of s.sizes.all(high, limit)) {
    const seq = Number(row.seq);
    seen++;
    const rows = rowsAt(s, seq);
    const bytes = Number(row.bytes) + rows.bytes;
    if (bytes > budget) {
      rejected.add(seq);
      low = seq;
      continue;
    }
    if (spent + bytes > budget) {
      full = true;
      break;
    }
    spent += bytes;
    if (!rows.check()) rejected.add(seq);
    low = seq;
  }
  // A short page that wasn't cut by the budget reached the oldest event.
  if (!full && seen < limit) low = 0;
  if (low === high) return undefined;
  for (const row of s.orphans.all(low, high)) rejected.add(Number(row.seq));
  return { from: low, rejected: [...rejected] };
}
