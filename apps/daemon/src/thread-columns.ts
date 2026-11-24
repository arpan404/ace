import { ThreadClientFields, ThreadDetails, ThreadProviderMetadata } from "@ace/protocol";
import type { EventPayload } from "@ace/protocol";
import type { ThreadPart } from "./thread-row.ts";
import type { FrozenThread } from "./thread-cache.ts";

type ReadonlyThread = FrozenThread;

/** What a column stores: text, a number or NULL, readable back as itself. */
export type ColumnValue = string | number | null;

const ThreadClientColumn = ThreadClientFields.omit({ details: true });
const clientKeys = Object.keys(ThreadClientColumn.shape);

/** How each stored column is written from a thread, and the part of the thread it holds. */
const columns = {
  id: { part: "base", encode: (thread: ReadonlyThread) => thread.id },
  workspace_id: { part: "base", encode: (thread: ReadonlyThread) => thread.workspaceId },
  title: { part: "base", encode: (thread: ReadonlyThread) => thread.title },
  provider: { part: "base", encode: (thread: ReadonlyThread) => thread.provider },
  created_at: { part: "base", encode: (thread: ReadonlyThread) => thread.createdAt },
  updated_at: { part: "base", encode: (thread: ReadonlyThread) => thread.updatedAt },
  archived_at: { part: "base", encode: (thread: ReadonlyThread) => thread.archivedAt ?? null },
  imported: {
    part: "base",
    encode: (thread: ReadonlyThread) => (thread.imported ? JSON.stringify(thread.imported) : null),
  },
  root_agent_id: { part: "base", encode: (thread: ReadonlyThread) => thread.rootAgentId ?? null },
  status: { part: "status", encode: (thread: ReadonlyThread) => JSON.stringify(thread.status) },
  client: { part: "client", encode: encodeThreadClient },
  details: {
    part: "details",
    encode: (thread: ReadonlyThread) =>
      thread.details === undefined ? null : JSON.stringify(ThreadDetails.parse(thread.details)),
  },
  transitions: {
    part: "transitions",
    encode: (thread: ReadonlyThread) =>
      JSON.stringify({
        lineage: thread.lineage,
        delegatedBy: thread.delegatedBy,
        delegatedFrom: thread.delegatedFrom,
        startedBy: thread.startedBy,
        startedByClient: thread.startedByClient,
        treeRootId: thread.treeRootId,
        queuedLaunch: thread.queuedLaunch,
        execution: thread.execution,
        switch: thread.switch,
      }),
  },
  provider_metadata: {
    part: "metadata",
    encode: (thread: ReadonlyThread) =>
      JSON.stringify({
        backend: thread.backend,
        handoff: thread.handoff,
        permission: thread.permission,
        titleSource: thread.titleSource,
        queue: thread.queue,
        goal: thread.goal,
      }),
  },
  capabilities: {
    part: "capabilities",
    encode: (thread: ReadonlyThread) =>
      thread.capabilities === undefined ? null : JSON.stringify(thread.capabilities),
  },
  acp: {
    part: "acp",
    encode: (thread: ReadonlyThread) => JSON.stringify(ThreadProviderMetadata.parse(thread)),
  },
} satisfies Record<string, { part: ThreadPart; encode: (thread: ReadonlyThread) => ColumnValue }>;
export type ThreadColumn = keyof typeof columns;
/**
 * Cheap stand-ins for encodings that validate: equal stand-ins give equal encodings, since
 * an encoding reads only these values. A column changes on most events' checks, but is
 * encoded only when it changed.
 */
const comparisons: Partial<Record<ThreadColumn, (thread: ReadonlyThread) => string>> = {
  client: (thread) => JSON.stringify(clientKeys.map((key) => Reflect.get(thread, key))),
  details: (thread) => JSON.stringify(thread.details) ?? "",
};
const columnNames = Object.keys(columns) as ThreadColumn[];
/** Every column, in the table's order (what `columnNames` holds). */
export const threadColumnNames: readonly ThreadColumn[] = columnNames;
/** Columns of the large, rarely changing values kept in thread_cold rather than threads. */
const coldColumns = new Set<ThreadColumn>(["details", "capabilities"]);

/** The client column: organization and live run state. Details are stored on their own. */
export function encodeThreadClient(thread: ReadonlyThread): string {
  return JSON.stringify(ThreadClientColumn.parse(thread));
}

export function threadColumnValue(thread: ReadonlyThread, name: ThreadColumn): ColumnValue {
  return columns[name].encode(thread);
}

/** The columns of `wanted` whose stored value would change from `previous` to `next`. */
export interface ThreadColumnChanges {
  /** Every column the rebuilt thread reads: the changed ones, and the rest of their parts. */
  row: Record<string, ColumnValue>;
  hot: [ThreadColumn, ColumnValue][];
  cold: [ThreadColumn, ColumnValue][];
  parts: Set<ThreadPart>;
}
export function threadColumnChanges(
  previous: ReadonlyThread | undefined,
  next: ReadonlyThread,
  wanted: readonly ThreadColumn[],
): ThreadColumnChanges {
  const changes: ThreadColumnChanges = { row: {}, hot: [], cold: [], parts: new Set() };
  for (const name of wanted) {
    const column = columns[name];
    const compare = comparisons[name] ?? column.encode;
    if (previous && compare(previous) === compare(next)) continue;
    const value = column.encode(next);
    // A new thread without a cold value needs no cold row: a missing one reads the same.
    if (!previous && coldColumns.has(name) && value === null) continue;
    (coldColumns.has(name) ? changes.cold : changes.hot).push([name, value]);
    changes.parts.add(column.part);
    changes.row[name] = value;
  }
  // A changed part is decoded again from all of its columns, written or not.
  for (const name of columnNames)
    if (changes.parts.has(columns[name].part) && !(name in changes.row))
      changes.row[name] = columns[name].encode(previous ?? next);
  return changes;
}

const updated: ThreadColumn[] = [
  "workspace_id",
  "title",
  "status",
  "updated_at",
  "archived_at",
  "root_agent_id",
  "provider",
  "transitions",
  "provider_metadata",
  "capabilities",
  // Any event may fold client fields (a status change sets activitySeq), so all are checked.
  "client",
  "details",
];
/** The columns an event may write. Others keep their stored value, whatever it folded. */
export function writtenColumns(payload: EventPayload): ThreadColumn[] {
  if (payload.type === "item.delta") return [];
  const wanted = [...updated];
  if (
    payload.type === "thread.created" ||
    (payload.type === "thread.updated" &&
      (payload.effectiveCapabilities !== undefined ||
        payload.acpSupport !== undefined ||
        payload.acp !== undefined))
  )
    wanted.push("acp");
  return wanted;
}

/** What `writeThread`'s cold upsert binds after `thread_id`: details, then capabilities. */
export function coldRowValues(
  previous: ReadonlyThread | undefined,
  changes: ThreadColumnChanges,
): [ColumnValue, ColumnValue] {
  const value = (name: ThreadColumn) => {
    const change = changes.cold.find(([column]) => column === name);
    return change ? change[1] : previous ? threadColumnValue(previous, name) : null;
  };
  return [value("details"), value("capabilities")];
}
