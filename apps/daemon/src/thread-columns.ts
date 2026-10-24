import { ThreadClientFields, ThreadDetails, ThreadProviderMetadata } from "@ace/protocol";
import type { ThreadPart } from "./thread-row.ts";
import type { FrozenThread } from "./thread-cache.ts";

type ReadonlyThread = FrozenThread;

/** What a column stores: text, a number or NULL, readable back as itself. */
export type ColumnValue = string | number | null;

const ThreadClientColumn = ThreadClientFields.omit({ details: true });

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
        run: thread.run,
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
const columnNames = Object.keys(columns) as ThreadColumn[];
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
    const value = column.encode(next);
    // A new thread without a cold value needs no cold row: a missing one reads the same.
    if (previous ? column.encode(previous) === value : coldColumns.has(name) && value === null)
      continue;
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
