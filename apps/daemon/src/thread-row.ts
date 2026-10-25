import type { SQLOutputValue } from "node:sqlite";
import { OffshiftRunMark } from "@ace/protocol/offshift";
import {
  ProviderGoal,
  Thread,
  ThreadClientFields,
  ThreadTransitionView,
  ThreadProviderMetadata,
} from "@ace/protocol";

type Row = Record<string, SQLOutputValue>;
type ReadonlyThread = { readonly [K in keyof Thread]?: unknown };

/**
 * A thread is stored as the narrow threads row, which changes on most events, plus its two
 * large and rarely changing values in thread_cold. Every full read selects both.
 */
export const threadRowColumns =
  "threads.*, cold.details AS details, cold.capabilities AS capabilities";
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
      ...goalRunPart.parse({ ...storedGoal(value), ...storedRun(value) }),
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
const goalRunPart = Thread.pick({ goal: true, run: true });
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

/** Decode a materialized thread row; provider and client extensions retain their schemas. */
export function decodeThreadRow(row: Row): Thread {
  const fields: Record<string, unknown> = {};
  for (const name of partNames) Object.assign(fields, parts[name](row));
  return assemble(fields);
}

/**
 * The thread a row decodes to after a write that changed only `changed` parts, from the thread
 * the row decoded to before it and the written columns in `row`. Parts not changed are shared
 * with `previous`; decoded parts are private copies.
 */
export function rebuildThread(
  previous: ReadonlyThread | undefined,
  row: Row,
  changed: ReadonlySet<ThreadPart>,
): Thread {
  const fields: Record<string, unknown> = {};
  for (const name of partNames) {
    if (changed.has(name) || !previous) Object.assign(fields, structuredClone(parts[name](row)));
    else
      for (const key of partKeys[name])
        if (key in previous) fields[key] = previous[key as keyof Thread];
  }
  return assemble(fields);
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

/** A stored run mark the current schema can't read is dropped: the run's next write restores it. */
function storedRun(metadata: unknown): { run?: OffshiftRunMark } {
  const run = OffshiftRunMark.safeParse(
    typeof metadata === "object" && metadata !== null ? Reflect.get(metadata, "run") : undefined,
  );
  return run.success ? { run: run.data } : {};
}
