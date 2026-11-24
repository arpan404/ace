import type { DatabaseSync, StatementSync } from "node:sqlite";
import { type Event, type EventPayload, type Thread, type ThreadId } from "@ace/protocol";
import { storeWriterOn } from "@ace/provider-kit/native-switches";
import { foldThread } from "./native-writer/fold.ts";
import { createThread, storeEvent } from "./native-writer/events.ts";
import { canonicalEvent } from "./canonical-event.ts";
import { prepareRunClient } from "./run-client-storage.ts";
import { liveMetadataChange } from "./thread-client-storage.ts";
import {
  coldRowValues,
  threadColumnChanges,
  writtenColumns,
  type ColumnValue,
} from "./thread-columns.ts";
import { rebuildThread } from "./thread-row.ts";
import { keepThreadRowConfirmed, threadRowConfirmed } from "./thread-row-trust.ts";
import type { FrozenThread } from "./thread-cache.ts";
import type { SequenceAllocator } from "./stream-sequences.ts";
import type { PayloadStore } from "./payload-store.ts";
import type { HistoryIndex } from "./history-index.ts";
import type { StatusStore } from "./status-store.ts";
import type { LongThreadIndex } from "./long-thread/index.ts";
import type { McpData } from "./mcp-data.ts";
import type { SearchIndex } from "@ace/search";
import type { ToolResultStore } from "./tool-result-store.ts";
import type { NativeImageStore } from "./native-image-store.ts";
import type { MeasurementStore } from "./measurement-store.ts";
import type { NeedsYouThreads } from "./needs-you-threads.ts";
interface EventWriteSource {
  db: DatabaseSync;
  sequences: SequenceAllocator;
  payloads: PayloadStore;
  history: HistoryIndex;
  status: StatusStore;
  longThreads: LongThreadIndex;
  mcp: McpData;
  search: SearchIndex;
  toolResults: ToolResultStore;
  nativeImages: NativeImageStore;
  measurements: MeasurementStore;
  needsYou: NeedsYouThreads;
  statement(sql: string): StatementSync;
  getThread(id: ThreadId): Thread | undefined;
  /** The shared frozen thread and a private copy, made when first read, from one lookup. */
  checkoutThread(id: ThreadId): { base: FrozenThread; readonly thread: Thread } | undefined;
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
      // A delta changes no thread column (`writtenColumns`) and folds nothing into the thread,
      // so it reads the shared frozen thread; a write to it would throw, never pass silently.
      const delta = payload.type === "item.delta";
      const previous = delta ? (checkout?.base as Thread | undefined) : checkout?.thread;
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
        if (storeWriterOn("events")) {
          // The same check order as the TypeScript path: an unregistered workspace wins
          // over an invalid or duplicate creation. The native writer checks it again.
          if (
            this.source
              .statement("SELECT 1 FROM workspace_unregistered WHERE workspace_id=?")
              .get(thread.workspaceId)
          )
            throw new Error("workspace_unregistered");
          if (thread.id !== threadId || checkout) throw new Error("Invalid thread creation");
          createThread(this.source.db, {
            id: thread.id,
            workspaceId: thread.workspaceId,
            title: thread.title,
            provider: thread.provider,
            statusJson: JSON.stringify(thread.status),
            createdAt: thread.createdAt,
            updatedAt: event.at,
            importedJson: thread.imported ? JSON.stringify(thread.imported) : null,
            imported: Boolean(thread.imported),
          });
        } else {
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
          // Work starting in a project makes it the most recently used one there (ADR 0180): a
          // machine's default checkout. A thread imported from history started nothing now.
          if (!thread.imported)
            this.source
              .statement(
                "INSERT INTO workspace_recent VALUES (?,?) ON CONFLICT(workspace_id) DO UPDATE SET opened_at=max(opened_at,excluded.opened_at)",
              )
              .run(thread.workspaceId, event.at);
        }
      } else {
        const existing = previous;
        if (!existing) throw new Error("Unknown thread");
        thread = existing;
      }
      const liveChange = liveMetadataChange(this.source.db, thread, event.payload, event.at);
      if (liveChange) followup = liveChange;
      if (!delta) {
        foldThread(this.source.db, thread, event);
        this.writeThread(checkout?.base, thread, event.payload);
        this.source.needsYou.observe(thread);
      }
      event.payload = this.source.payloads.cap(event.payload, threadId);
      this.source.payloads.persist(event);
      this.source.history.record(event);
      this.source.status.persist(event, thread);
      this.source.longThreads.append(event, thread, previousSeq);
      if (storeWriterOn("events"))
        storeEvent(this.source.db, {
          seq,
          id: event.id,
          threadId,
          at,
          kind: event.payload.type,
          payloadJson: JSON.stringify(event.payload),
        });
      else {
        this.source
          .statement(
            "INSERT INTO events (seq, id, thread_id, at, type, payload) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(seq, event.id, threadId, at, event.payload.type, JSON.stringify(event.payload));
        this.source.statement("UPDATE host_sequence SET seq = MAX(seq,?) WHERE id = 1").run(seq);
      }
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
      const values = coldRowValues(previous, changes);
      this.source
        .statement(
          `INSERT INTO thread_cold (thread_id, details, capabilities) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET ${changes.cold.map(([name]) => `${name} = excluded.${name}`).join(", ")}`,
        )
        .run(thread.id, values[0], values[1]);
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
