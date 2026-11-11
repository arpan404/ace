import { Event, EventPayload, Item, type EventId, type ThreadId } from "@ace/protocol";
import { z } from "zod";

const tagged = z.looseObject({ type: z.string() });
/** Unknown persisted variants remain opaque, including the original discriminator and fields. */
export function decodeStoredPayload(value: unknown): EventPayload {
  const input = tagged.parse(value);
  if (input.type === "item.created" || input.type === "item.updated")
    return EventPayload.parse({ ...input, item: decodeStoredItem(input.item) });
  if (EventPayload.options.some((option) => option.shape.type.value === input.type))
    return EventPayload.parse(value);
  return EventPayload.parse({ type: "unknown", raw: value });
}
export function decodeStoredItem(value: unknown): Item {
  const input = tagged.parse(value);
  if (Item.options.some((option) => option.shape.type.value === input.type))
    return Item.parse(value);
  return Item.parse({ ...input, type: "unknown", raw: [], data: value });
}

/**
 * Where this build's own rows start (`stored-shape.ts`). Shared by the stores that read rows,
 * and set once at open, after migrations. Until then nothing is trusted.
 */
export interface StoredTrust {
  from: number;
}
export const untrusted = (): StoredTrust => ({ from: Number.POSITIVE_INFINITY });
/**
 * A stored payload by its row's sequence. Rows from `trustedFrom` on were validated by this
 * build's writer and are already in its shape (`stored-shape.ts`), so they are parsed as JSON
 * only; older rows are decoded leniently as above.
 */
export function storedPayload(seq: number, json: string, trustedFrom: number): EventPayload {
  const value: unknown = JSON.parse(json);
  // Trusted: this build's writer produced this JSON from a validated EventPayload.
  return seq >= trustedFrom ? (value as EventPayload) : decodeStoredPayload(value);
}
/** A stored item by the sequence it was created at; see `storedPayload`. */
export function storedItem(createdSeq: number, json: string, trustedFrom: number): Item {
  const value: unknown = JSON.parse(json);
  // Trusted: this build's writer produced this JSON from a validated Item.
  return createdSeq >= trustedFrom ? (value as Item) : decodeStoredItem(value);
}
/**
 * An `events` row as an Event, with its size as JSON (what replay pages budget by). A row this
 * build wrote is rebuilt in the schema's field order from its columns and stored JSON, so its
 * size is the stored JSON plus the envelope, without serialising it again. Older rows are
 * decoded and validated as before.
 */
export function storedEvent(
  row: Record<string, unknown>,
  trustedFrom: number,
): { event: Event; bytes: number } {
  const seq = Number(row.seq);
  const json = String(row.payload);
  const payload = storedPayload(seq, json, trustedFrom);
  if (seq < trustedFrom) {
    const event = Event.parse({ seq, id: row.id, threadId: row.thread_id, at: row.at, payload });
    return { event, bytes: Buffer.byteLength(JSON.stringify(event)) };
  }
  // Trusted: this build wrote the row's id and thread id from validated values.
  const id = String(row.id) as EventId;
  const threadId = String(row.thread_id) as ThreadId;
  const at = Number(row.at);
  const event: Event = { seq, id, at, threadId, payload };
  const envelope = `{"seq":${seq},"id":${JSON.stringify(id)},"at":${at},"threadId":${JSON.stringify(threadId)},"payload":}`;
  return { event, bytes: Buffer.byteLength(json) + Buffer.byteLength(envelope) };
}
