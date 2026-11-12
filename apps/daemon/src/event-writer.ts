import type { DatabaseSync, StatementSync } from "node:sqlite";
import { type Event, type EventPayload, type Thread, type ThreadId } from "@ace/protocol";
import { updateThread } from "@ace/projection";
import { canonicalEvent } from "./canonical-event.ts";
import { prepareRunClient } from "./run-client-storage.ts";
import { liveMetadataChange } from "./thread-client-storage.ts";
import {
  threadColumnChanges,
  threadColumnValue,
  type ColumnValue,
  type ThreadColumn,
} from "./thread-columns.ts";
import { rebuildThread } from "./thread-row.ts";
import { keepThreadRowConfirmed, threadRowConfirmed } from "./thread-row-trust.ts";
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
  /** This writer just wrote `written` to the thread's row, which decodes to `thread` at `revision`. */
  rememberThread(
    id: ThreadId,
    revision: number,
    thread: Thread,
    written: Record<string, ColumnValue>,
  ): void;
  /** As `rememberThread`, for a thread this writer just created with every column in `row`. */
  rememberCreatedThread(
    id: ThreadId,
    revision: number,
    thread: Thread,
    row: Record<string, ColumnValue>,
  ): void;
  nextId(): string;
  wakeSearch(): void;
}
/** An envelope before it is made canonical; its id is any string `nextId` made. */
type EventInput = Omit<Event, "id" | "payload"> & { id: string; payload: EventPayload };
/** Canonical folding and derived-table writes. The caller owns the SQLite transaction. */
export class EventWriter {
  private readonly source: EventWriteSource;
  constructor(source: EventWriteSource) {
    this.source = source;
  }
  /**
   * Fold and store payloads built by ace, each made canonical by `canonicalEvent` (what
   * `Event.parse` gives, so the row is in this build's shape). A supplied envelope was made
   * canonical when it was built and is stored as it is.
   */
  append(threadId: ThreadId, payloads: EventPayload[], at: number, envelopes?: Event[]): Event[] {
    return this.write(threadId, payloads, at, envelopes, (input) => canonicalEvent(input));
  }
  /**
   * As `append`, for payloads that are already canonical (a live envelope stored under a new
   * sequence). Canonicalising is idempotent on its own output, so they are not canonicalised
   * again unless preparing or decorating them built a new payload.
   */
  appendParsed(threadId: ThreadId, payloads: EventPayload[], at: number): Event[] {
    return this.write(threadId, payloads, at, undefined, (input, given) =>
      // Trusted: `given` is canonical, and seq, id, at and thread id are ace's own.
      input.payload === given ? (input as Event) : canonicalEvent(input),
    );
  }
  private write(
    threadId: ThreadId,
    payloads: EventPayload[],
    at: number,
    envelopes: Event[] | undefined,
    canonical: (input: EventInput, given: EventPayload) => Event,
  ): Event[] {
    let seq = this.source.sequences.head();
    const afterSeq = seq;
    const events: Event[] = [];
    let followup: EventPayload | undefined;
    let inputIndex = 0;
    while (followup || inputIndex < payloads.length) {
      // A supplied envelope belongs to its input payload only; a follow-up is a new append.
      const envelope = followup ? undefined : envelopes?.[inputIndex];
      const isFollowup = followup !== undefined;
      const payload = followup ?? payloads[inputIndex++];
      followup = undefined;
      if (!payload) break;
      const previousSeq = seq;
      const checkout = this.source.checkoutThread(threadId);
      const previous = checkout?.thread;
      // Runs for an envelope too: it also records the turn's ask, whatever is stored.
      const prepared = previous ? prepareRunClient(this.source.db, previous, payload) : payload;
      let event = envelope;
      if (!event) {
        seq = this.source.sequences.next(seq);
        const input: EventInput = {
          seq,
          id: this.source.nextId(),
          at,
          threadId,
          payload: this.decorate(threadId, prepared, seq),
        };
        // A follow-up was built here from stored rows, never made canonical.
        event = isFollowup ? canonicalEvent(input) : canonical(input, payload);
      }
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
  private decorate(threadId: ThreadId, payload: EventPayload, seq: number): EventPayload {
    const { toolResults, nativeImages, measurements } = this.source;
    return toolResults.decorate(
      threadId,
      nativeImages.decorate(threadId, measurements.decorate(threadId, payload, seq)),
      seq,
    );
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
    if (!changes.hot.length && !changes.cold.length) return;
    // A new row is written whole here; an existing one keeps the columns this write leaves.
    const confirmed =
      !previous || threadRowConfirmed((sql) => this.source.statement(sql), thread.id);
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
    const revision = this.source
      .statement("SELECT revision FROM sidebar_thread_revisions WHERE thread_id = ?")
      .get(thread.id)?.revision;
    if (typeof revision !== "number") return;
    const { thread: rebuilt, canonical } = rebuildThread(previous, changes.row, changes.parts);
    if (confirmed && canonical)
      keepThreadRowConfirmed((sql) => this.source.statement(sql), thread.id, revision);
    if (previous) this.source.rememberThread(thread.id, revision, rebuilt, changes.row);
    else this.source.rememberCreatedThread(thread.id, revision, rebuilt, changes.row);
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
  // Any event may fold client fields (a status change sets activitySeq), so all are checked.
  "client",
  "details",
];
/** The columns an event may write. Others keep their stored value, whatever it folded. */
function writtenColumns(payload: EventPayload): ThreadColumn[] {
  if (payload.type === "item.delta") return [];
  const columns = [...updated];
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
