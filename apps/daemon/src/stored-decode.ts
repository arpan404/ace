import type { SQLOutputValue } from "node:sqlite";
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
  ThreadClientFields,
  ThreadProviderMetadata,
  ThreadTransitionView,
  UsageUpdated,
  type AgentId,
  type AgentStatus,
  type EventId,
  type Thread,
  type ThreadId,
  type ThreadStatus,
  type TurnDigest,
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
/**
 * A stored item by the sequence its body was written at, see `storedPayload`: an `items` row's
 * creation sequence, or a history revision's own sequence (`history_item_revisions.seq`, written
 * in the transaction of the event at that sequence).
 */
export function storedItem(createdSeq: number, json: string, trustedFrom: number): Item {
  const value: unknown = JSON.parse(json);
  // Trusted: this build's writer produced this JSON from a validated Item.
  return createdSeq >= trustedFrom ? (value as Item) : decodeStoredItem(value);
}
/**
 * An `item_text_chunks` row at or after the trusted start: `ItemStore.append` wrote its field
 * and its JSON-encoded append from a validated `item.delta`.
 */
export function storedTextChunk(
  field: unknown,
  append: unknown,
): { field: Extract<EventPayload, { type: "item.delta" }>["field"]; append: string } {
  // Trusted: written from an `item.delta` the event writer validated.
  return {
    field: field as Extract<EventPayload, { type: "item.delta" }>["field"],
    append: JSON.parse(String(append)) as string,
  };
}
/**
 * Rows of the thread summary index (`long-thread/`). Only its writer fills them, from validated
 * events, and an index in an older layout is refused at open (`long-thread/database.ts`).
 */
export function storedIndexCommand(json: string): TurnDigest["commands"][number] {
  // Trusted: the writer stored a command preview built from a validated tool call.
  return JSON.parse(json) as TurnDigest["commands"][number];
}
export function storedIndexStatus(json: string): ThreadStatus {
  // Trusted: the writer stored a validated thread status.
  return JSON.parse(json) as ThreadStatus;
}
export function storedIndexAgentId(value: unknown): AgentId {
  // Trusted: the writer stored the id of a validated agent.
  return String(value) as AgentId;
}
export function storedIndexAgentStatus(json: string): AgentStatus {
  // Trusted: the writer stored a validated agent status.
  return JSON.parse(json) as AgentStatus;
}
/**
 * An item row the current write transaction stored moments ago from a validated Item, such as
 * the text preview the item store seeds for the event being written. Never for a row that may
 * predate this transaction.
 */
export function justWrittenItem(json: string): Item {
  // Trusted: written in this transaction from Event.parse output.
  return JSON.parse(json) as Item;
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

type StoredRow = Record<string, SQLOutputValue>;
/** Fields of `value` named in `keys`, as a schema pick of them gives (absent keys stay absent). */
function picked(value: unknown, keys: readonly string[]): Partial<Thread> {
  const fields: Record<string, unknown> = {};
  if (typeof value !== "object" || value === null) return fields;
  for (const key of keys) if (key in value) fields[key] = Reflect.get(value, key);
  return fields;
}
const clientKeys = Object.keys(ThreadClientFields.omit({ details: true }).shape);
const transitionKeys = Object.keys(ThreadTransitionView.shape);
const metadataKeys = ["backend", "handoff", "permission", "titleSource", "queue", "goal"];
const acpKeys = Object.keys(ThreadProviderMetadata.shape);
const stored = (value: SQLOutputValue | undefined): unknown =>
  value == null ? undefined : JSON.parse(String(value));
/**
 * A threads row's parts read as stored, for a row this build confirmed reads the same without
 * validation (`thread-row-trust.ts`). Each mirrors the validating part in `thread-row.ts` minus
 * the schema parse; a row whose stored JSON the parse would change, or that still carries the
 * values older layouts embedded in client and provider_metadata, is never confirmed.
 */
export const trustedThreadParts = {
  base: (row: StoredRow) => {
    // Trusted: this build wrote the base columns from a validated Thread.
    const base: Record<string, unknown> = {
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      provider: row.provider,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.archived_at !== null) base.archivedAt = row.archived_at;
    if (row.imported != null) base.imported = JSON.parse(String(row.imported));
    if (row.root_agent_id !== null) base.rootAgentId = row.root_agent_id;
    return base as Partial<Thread>;
  },
  status: (row: StoredRow) => ({ status: JSON.parse(String(row.status)) as Thread["status"] }),
  client: (row: StoredRow) => picked(stored(row.client), clientKeys),
  details: (row: StoredRow) => {
    const details = stored(row.details);
    return details === undefined ? {} : { details: details as Thread["details"] };
  },
  transitions: (row: StoredRow) => picked(stored(row.transitions), transitionKeys),
  metadata: (row: StoredRow) => picked(stored(row.provider_metadata), metadataKeys),
  capabilities: (row: StoredRow) => {
    const capabilities = stored(row.capabilities);
    return capabilities === undefined
      ? {}
      : { capabilities: capabilities as Thread["capabilities"] };
  },
  acp: (row: StoredRow) => picked(stored(row.acp), acpKeys),
} satisfies Record<string, (row: StoredRow) => Partial<Thread>>;
/** The trusted thread decoders' code, part of the thread row shape (`thread-row-trust.ts`). */
export function trustedThreadDecoderSource(): string {
  return [picked, stored, ...Object.values(trustedThreadParts)].map(String).join("\n");
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

/** A take-over row in `spade_computer_drivers`; only this build's driver store writes them. */
export function storedTakeover(json: string): import("./spade/computer-drivers.ts").Takeover {
  // Trusted: written by `storedTakeovers` from a Takeover this daemon built.
  return JSON.parse(json) as import("./spade/computer-drivers.ts").Takeover;
}
