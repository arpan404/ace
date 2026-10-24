import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  Event,
  ThreadProviderMetadata,
  type EventPayload,
  type Thread,
  type ThreadId,
} from "@ace/protocol";
import { updateThread } from "@ace/projection";
import { prepareRunClient } from "./run-client-storage.ts";
import { liveMetadataChange } from "./thread-client-storage.ts";
import {
  threadColumnChanges,
  threadColumnValue,
  type ColumnValue,
  type ThreadColumn,
} from "./thread-columns.ts";
import { rebuildThread } from "./thread-row.ts";
import type { FrozenThread } from "./thread-cache.ts";
import type { StreamSequences } from "./stream-sequences.ts";
import type { PayloadStore } from "./payload-store.ts";
import type { HistoryIndex } from "./history-index.ts";
import type { StatusStore } from "./status-store.ts";
import type { LongThreadIndex } from "./long-thread/index.ts";
import type { McpData } from "./mcp-data.ts";
import type { SearchIndex } from "@ace/search";
import type { ToolResultStore } from "./tool-result-store.ts";
import type { NativeImageStore } from "./native-image-store.ts";
import type { MeasurementStore } from "./measurement-store.ts";
interface EventWriteSource {
  db: DatabaseSync;
  sequences: StreamSequences;
  payloads: PayloadStore;
  history: HistoryIndex;
  status: StatusStore;
  longThreads: LongThreadIndex;
  mcp: McpData;
  search: SearchIndex;
  toolResults: ToolResultStore;
  nativeImages: NativeImageStore;
  measurements: MeasurementStore;
  statement(sql: string): StatementSync;
  getThread(id: ThreadId): Thread | undefined;
  /** The shared frozen thread and a private copy, from one cache lookup. */
  checkoutThread(id: ThreadId): { base: FrozenThread; thread: Thread } | undefined;
  /** This writer just wrote the thread's row, which decodes to `thread` at `revision`. */
  rememberThread(
    id: ThreadId,
    revision: number,
    thread: Thread,
    written: Record<string, ColumnValue>,
  ): void;
  nextId(): string;
  wakeSearch(): void;
}
/** Canonical folding and derived-table writes. The caller owns the SQLite transaction. */
export class EventWriter {
  private readonly source: EventWriteSource;
  constructor(source: EventWriteSource) {
    this.source = source;
  }
  append(threadId: ThreadId, payloads: EventPayload[], at: number, envelopes?: Event[]): Event[] {
    let seq = this.source.sequences.head();
    const afterSeq = seq;
    const events: Event[] = [];
    let followup: EventPayload | undefined;
    let inputIndex = 0;
    while (followup || inputIndex < payloads.length) {
      // A supplied envelope belongs to its input payload only; a follow-up is a new append.
      const envelope = followup ? undefined : envelopes?.[inputIndex];
      const payload = followup ?? payloads[inputIndex++];
      followup = undefined;
      if (!payload) break;
      const previousSeq = seq;
      const checkout = this.source.checkoutThread(threadId);
      const previous = checkout?.thread;
      const prepared = previous ? prepareRunClient(this.source.db, previous, payload) : payload;
      const event =
        envelope ??
        Event.parse({
          seq: (seq = this.source.sequences.next(seq)),
          id: this.source.nextId(),
          threadId,
          at,
          payload: this.source.toolResults.decorate(
            threadId,
            this.source.nativeImages.decorate(
              threadId,
              this.source.measurements.decorate(threadId, prepared, seq),
            ),
            seq,
          ),
        });
      seq = event.seq;
      if (!Number.isSafeInteger(seq)) throw new Error("Sequence exhausted");
      let thread: Thread;
      if (event.payload.type === "thread.created") {
        thread = event.payload.thread;
        if (
          this.source
            .statement("SELECT 1 FROM workspace_unregistered WHERE workspace_id=?")
            .get(thread.workspaceId)
        )
          throw new Error("workspace_unregistered");
        if (thread.id !== threadId || checkout) throw new Error("Invalid thread creation");
        this.source
          .statement(
            "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at, imported) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            thread.id,
            thread.workspaceId,
            thread.title,
            thread.provider,
            JSON.stringify(thread.status),
            thread.createdAt,
            event.at,
            thread.imported ? JSON.stringify(thread.imported) : null,
          );
      } else {
        const existing = previous;
        if (!existing) throw new Error("Unknown thread");
        thread = existing;
      }
      const liveChange = liveMetadataChange(this.source.db, thread, event.payload, event.at);
      if (liveChange) followup = liveChange;
      updateThread(thread, event);
      this.writeThread(checkout?.base, thread, event.payload);
      event.payload = this.source.payloads.cap(event.payload, threadId);
      this.source.payloads.persist(event);
      this.source.history.record(event);
      this.source.status.persist(event, thread);
      this.source.longThreads.append(event, thread, previousSeq);
      this.source
        .statement("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)")
        .run(seq, event.id, threadId, at, event.payload.type, JSON.stringify(event.payload));
      this.source.statement("UPDATE host_sequence SET seq = MAX(seq,?) WHERE id = 1").run(seq);
      this.source.mcp.apply(event, thread);
      events.push(event);
    }
    if (
      events.some(
        (event) =>
          event.payload.type === "thread.created" ||
          event.payload.type === "thread.updated" ||
          event.payload.type === "thread.client.updated",
      )
    ) {
      const current = this.source.getThread(threadId);
      if (current?.deletedAt !== undefined) this.source.search.deleteThread(threadId);
      else if (current) this.source.search.observeThread(current, seq);
    }
    this.source.search.appendCovered(events, afterSeq);
    this.source.wakeSearch();
    return events;
  }
  /**
   * Store what this event changed in the thread's columns, and nothing when it changed none,
   * which is most events. `previous` is what the row decoded to before (none on creation).
   */
  private writeThread(
    previous: FrozenThread | undefined,
    thread: Thread,
    payload: EventPayload,
  ): void {
    const changes = threadColumnChanges(previous, thread, writtenColumns(payload));
    if (changes.hot.length)
      this.source
        .statement(
          `UPDATE threads SET ${changes.hot.map(([name]) => `${name} = ?`).join(", ")} WHERE id = ?`,
        )
        .run(...changes.hot.map(([, value]) => value), thread.id);
    if (changes.cold.length) {
      // A new cold row also needs the column that did not change.
      const value = (name: ThreadColumn) => {
        const change = changes.cold.find(([column]) => column === name);
        return change ? change[1] : previous ? threadColumnValue(previous, name) : null;
      };
      this.source
        .statement(
          `INSERT INTO thread_cold (thread_id, details, capabilities) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET ${changes.cold.map(([name]) => `${name} = excluded.${name}`).join(", ")}`,
        )
        .run(thread.id, value("details"), value("capabilities"));
    }
    if (!changes.hot.length && !changes.cold.length) return;
    const revision = this.source
      .statement("SELECT revision FROM sidebar_thread_revisions WHERE thread_id = ?")
      .get(thread.id)?.revision;
    if (typeof revision === "number")
      this.source.rememberThread(
        thread.id,
        revision,
        rebuildThread(previous, changes.row, changes.parts),
        changes.row,
      );
  }
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
];
const clientColumns: ThreadColumn[] = ["client", "details"];
/** The columns an event may write. Others keep their stored value, whatever it folded. */
function writtenColumns(payload: EventPayload): ThreadColumn[] {
  if (payload.type === "item.delta") return [];
  const columns = [...updated];
  if (payload.type === "thread.created" || payload.type === "thread.client.updated")
    columns.push(...clientColumns);
  if (
    payload.type === "thread.created" ||
    (payload.type === "thread.updated" &&
      (payload.effectiveCapabilities !== undefined ||
        payload.acpSupport !== undefined ||
        payload.acp !== undefined))
  )
    columns.push("acp");
  return columns;
}
