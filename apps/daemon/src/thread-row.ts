import type { SQLOutputValue } from "node:sqlite";
import {
  ProviderGoal,
  Thread,
  ThreadClientFields,
  ThreadTransitionView,
  ThreadProviderMetadata,
} from "@ace/protocol";
import { trustedThreadDecoderSource, trustedThreadParts } from "./stored-decode.ts";

type Row = Record<string, SQLOutputValue>;
type ReadonlyThread = { readonly [K in keyof Thread]?: unknown };

/**
 * A thread is stored as the narrow threads row, which changes on most events, plus its two
 * large and rarely changing values in thread_cold. Every full read selects both, and whether
 * this build confirmed the row at its current revision (`thread-row-trust.ts`).
 */
export const threadRowColumns = `threads.*, cold.details AS details, cold.capabilities AS capabilities, (SELECT trust.canonical FROM thread_row_trust AS trust JOIN sidebar_thread_revisions AS current ON current.thread_id = trust.thread_id AND current.revision = trust.revision WHERE trust.thread_id = threads.id) AS row_trusted`;
export const threadRowSource =
  "threads LEFT JOIN thread_cold AS cold ON cold.thread_id = threads.id";

/**
 * One stored part of a thread: the Thread fields it yields from its own columns, decoded on
 * their own. A thread is the union of its parts, so a writer that rewrote some columns can
 * rebuild the thread by decoding just those parts and keeping the rest.
 */
const parts = {
  base: (row: Row) =>
    basePart.parse({
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      provider: row.provider,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
      ...(row.imported == null ? {} : { imported: JSON.parse(String(row.imported)) }),
      ...(row.root_agent_id === null ? {} : { rootAgentId: row.root_agent_id }),
    }),
  status: (row: Row) => statusPart.parse({ status: JSON.parse(String(row.status)) }),
  client: (row: Row) =>
    row.client == null
      ? {}
      : clientPart.parse(ThreadClientFields.parse(JSON.parse(String(row.client)))),
  details: (row: Row) => {
    // Rows written before thread_cold kept details inside client.
    const details = embedded(row.client, "details") ?? json(row.details);
    return details === undefined ? {} : detailsPart.parse({ details });
  },
  transitions: (row: Row) =>
    row.transitions == null
      ? {}
      : transitionsPart.parse(ThreadTransitionView.parse(JSON.parse(String(row.transitions)))),
  metadata: (row: Row) => {
    if (row.provider_metadata == null) return {};
    const value: unknown = JSON.parse(String(row.provider_metadata));
    return {
      ...metadataPart.parse(value),
      ...goalRunPart.parse({ ...storedGoal(value) }),
    };
  },
  capabilities: (row: Row) => {
    // Rows written before thread_cold kept capabilities inside provider_metadata.
    const capabilities = embedded(row.provider_metadata, "capabilities") ?? json(row.capabilities);
    return capabilities === undefined ? {} : capabilitiesPart.parse({ capabilities });
  },
  acp: (row: Row) =>
    row.acp == null ? {} : acpPart.parse(ThreadProviderMetadata.parse(JSON.parse(String(row.acp)))),
} satisfies Record<string, (row: Row) => Partial<Thread>>;
export type ThreadPart = keyof typeof parts;
const partNames = [
  "base",
  "status",
  "client",
  "details",
  "transitions",
  "metadata",
  "capabilities",
  "acp",
] as const satisfies readonly ThreadPart[];

/** A pick mask naming every key of `shape`. */
function keysOf<T extends Record<string, unknown>>(shape: T): { [K in keyof T]: true } {
  const mask: Record<string, true> = {};
  for (const key of Object.keys(shape)) mask[key] = true;
  return mask as { [K in keyof T]: true };
}
const basePart = Thread.pick({
  id: true,
  workspaceId: true,
  title: true,
  provider: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
  imported: true,
  rootAgentId: true,
});
const statusPart = Thread.pick({ status: true });
const clientPart = Thread.pick(keysOf(ThreadClientFields.omit({ details: true }).shape));
const detailsPart = Thread.pick({ details: true });
const transitionsPart = Thread.pick(keysOf(ThreadTransitionView.shape));
const metadataPart = Thread.pick({
  backend: true,
  handoff: true,
  permission: true,
  titleSource: true,
  queue: true,
});
const goalRunPart = Thread.pick({ goal: true });
const capabilitiesPart = Thread.pick({ capabilities: true });
const acpPart = Thread.pick(keysOf(ThreadProviderMetadata.shape));
const partKeys: Record<ThreadPart, readonly string[]> = {
  base: Object.keys(basePart.shape),
  status: Object.keys(statusPart.shape),
  client: Object.keys(clientPart.shape),
  details: Object.keys(detailsPart.shape),
  transitions: Object.keys(transitionsPart.shape),
  metadata: [...Object.keys(metadataPart.shape), ...Object.keys(goalRunPart.shape)],
  capabilities: Object.keys(capabilitiesPart.shape),
  acp: Object.keys(acpPart.shape),
};
const fieldOrder = Object.keys(Thread.shape);

const trustedParts: Record<ThreadPart, (row: Row) => Partial<Thread>> = trustedThreadParts;

/**
 * Decode a materialized thread row into a value no one else holds. A row this build confirmed
 * at its current revision is read as stored; any other row is validated, with provider and
 * client extensions keeping their schemas.
 */
export function decodeThreadRow(row: Row): Thread {
  if (row.row_trusted === 1) return trustedThreadRow(row);
  // A private clone: parsed output can share nested default objects with the schema.
  return structuredClone(validatedThreadRow(row));
}
function validatedThreadRow(row: Row): Thread {
  const fields: Record<string, unknown> = {};
  for (const name of partNames) Object.assign(fields, parts[name](row));
  return assemble(fields);
}
function trustedThreadRow(row: Row): Thread {
  const fields: Record<string, unknown> = {};
  for (const name of partNames) Object.assign(fields, trustedParts[name](row));
  return assemble(fields);
}

/**
 * The validated decode of a row, and whether reading it as stored gives exactly the same
 * thread, field order included. Only such a row may be read without validation.
 */
export function confirmThreadRow(row: Row): { thread: Thread; canonical: boolean } {
  const thread = validatedThreadRow(row);
  return { thread, canonical: JSON.stringify(thread) === JSON.stringify(trustedThreadRow(row)) };
}
/** True when each named part of `row` reads the same as stored as validated (`decoded`). */
function sameAsStored(row: Row, decoded: ReadonlyMap<ThreadPart, Partial<Thread>>): boolean {
  for (const [name, part] of decoded) if (!sameFields(part, trustedParts[name](row))) return false;
  return true;
}
/** Same keys with the same values, nested key order included; `assemble` orders the top level. */
function sameFields(a: object, b: object): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys)
    if (!(key in b) || JSON.stringify(Reflect.get(a, key)) !== JSON.stringify(Reflect.get(b, key)))
      return false;
  return true;
}

/**
 * The thread a row decodes to after a write that changed only `changed` parts, from the thread
 * the row decoded to before it and the written columns in `row`. Parts not changed are shared
 * with `previous`; decoded parts are private copies. `canonical` says whether every decoded
 * part reads the same as stored, so a row confirmed before the write stays confirmed.
 */
export function rebuildThread(
  previous: ReadonlyThread | undefined,
  row: Row,
  changed: ReadonlySet<ThreadPart>,
): { thread: Thread; canonical: boolean } {
  const fields: Record<string, unknown> = {};
  const decoded = new Map<ThreadPart, Partial<Thread>>();
  for (const name of partNames) {
    if (changed.has(name) || !previous) {
      const part = parts[name](row);
      decoded.set(name, part);
      Object.assign(fields, structuredClone(part));
    } else
      for (const key of partKeys[name])
        if (key in previous) fields[key] = previous[key as keyof Thread];
  }
  return { thread: assemble(fields), canonical: sameAsStored(row, decoded) };
}

/** Fields in schema order, as a whole-object parse gives them, plus the derived continuation. */
function assemble(fields: Record<string, unknown>): Thread {
  if (fields.provider === "cursor" && fields.backend !== "cursor-sdk")
    fields.continuation = {
      state: "read_only",
      reason: "cursor_cli_retired",
      actionId: "thread.continue_new",
    };
  const thread: Record<string, unknown> = {};
  for (const key of fieldOrder) if (key in fields) thread[key] = fields[key];
  // Every field came from its part's slice of the Thread schema, and base and status are required.
  return thread as Thread;
}

function json(value: SQLOutputValue | undefined): unknown {
  return value == null ? undefined : JSON.parse(String(value));
}
function embedded(value: SQLOutputValue | undefined, key: string): unknown {
  const parsed = json(value);
  return typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, key) : undefined;
}

/** A stored goal the current schema can't read is dropped: the provider's next update restores it. */
function storedGoal(metadata: unknown): { goal?: ProviderGoal } {
  const goal = ProviderGoal.safeParse(
    typeof metadata === "object" && metadata !== null ? Reflect.get(metadata, "goal") : undefined,
  );
  return goal.success ? { goal: goal.data } : {};
}

/**
 * The decoders' own code, part of the thread row shape: a stamp made by one decoder says
 * nothing about another's (`thread-row-trust.ts`).
 */
export function threadRowDecoderSource(): string {
  const own = [
    ...Object.values(parts),
    assemble,
    storedGoal,
    embedded,
    json,
    validatedThreadRow,
    trustedThreadRow,
    sameFields,
  ];
  return `${own.map(String).join("\n")}\n${trustedThreadDecoderSource()}`;
}
