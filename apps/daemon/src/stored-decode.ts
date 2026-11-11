import {
  Agent,
  BackgroundTask,
  ContextMeter,
  Event,
  EventPayload,
  Interaction,
  Item,
  QueueState,
  Run,
  UsageUpdated,
  type EventId,
  type ThreadId,
} from "@ace/protocol";
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

/** The schema of each `view_entities` collection's values. */
export const storedEntitySchemas = {
  agents: Agent,
  runs: Run,
  interactions: Interaction,
  backgroundTasks: BackgroundTask,
  usage: UsageUpdated,
  contextMeters: ContextMeter,
  usageSnapshots: UsageUpdated,
  queue: QueueState,
} as const;
export type StoredEntityCollection = keyof typeof storedEntitySchemas;
export type StoredEntity<C extends StoredEntityCollection> = z.output<
  (typeof storedEntitySchemas)[C]
>;
/**
 * Whether every `view_entities` row is in this build's shape (`entity-shape.ts`). Entity rows are
 * rewritten in place, so trust is all or nothing: set once at open, after any row an older
 * build left was rewritten in this build's shape. Until then every row is decoded.
 */
export interface EntityTrust {
  trusted: boolean;
}
export const untrustedEntities = (): EntityTrust => ({ trusted: false });
/** A stored entity value decoded with its collection's schema, filling the schema's defaults. */
export function decodeStoredEntity<C extends StoredEntityCollection>(
  collection: C,
  value: unknown,
): StoredEntity<C> {
  return storedEntitySchemas[collection].parse(value) as StoredEntity<C>;
}
/** A `view_entities` value; see `EntityTrust`. */
export function storedEntity<C extends StoredEntityCollection>(
  collection: C,
  json: string,
  trust: EntityTrust,
): StoredEntity<C> {
  const value: unknown = JSON.parse(json);
  // Trusted: this build's writer produced this JSON from a value folded from validated events.
  return trust.trusted ? (value as StoredEntity<C>) : decodeStoredEntity(collection, value);
}
