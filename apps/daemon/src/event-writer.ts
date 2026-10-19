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
import { encodeThreadClient, liveMetadataChange } from "./thread-client-storage.ts";
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
      const previous = this.source.getThread(threadId);
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
        if (thread.id !== threadId || this.source.getThread(threadId))
          throw new Error("Invalid thread creation");
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
      if (event.payload.type === "thread.created" || event.payload.type === "thread.client.updated")
        this.source
          .statement("UPDATE threads SET client=? WHERE id=?")
          .run(encodeThreadClient(thread), thread.id);
      if (event.payload.type !== "item.delta")
        this.source
          .statement(
            "UPDATE threads SET workspace_id = ?, title = ?, status = ?, updated_at = ?, archived_at = ?, root_agent_id = ?, provider = ?, transitions = ?, provider_metadata = ? WHERE id = ?",
          )
          .run(
            thread.workspaceId,
            thread.title,
            JSON.stringify(thread.status),
            thread.updatedAt,
            thread.archivedAt ?? null,
            thread.rootAgentId ?? null,
            thread.provider,
            JSON.stringify({
              lineage: thread.lineage,
              delegatedBy: thread.delegatedBy,
              execution: thread.execution,
              switch: thread.switch,
            }),
            JSON.stringify({
              backend: thread.backend,
              capabilities: thread.capabilities,
              handoff: thread.handoff,
              permission: thread.permission,
              titleSource: thread.titleSource,
              queue: thread.queue,
            }),
            thread.id,
          );
      if (
        event.payload.type === "thread.created" ||
        (event.payload.type === "thread.updated" &&
          (event.payload.effectiveCapabilities !== undefined ||
            event.payload.acpSupport !== undefined ||
            event.payload.acp !== undefined))
      ) {
        this.source
          .statement("UPDATE threads SET acp = ? WHERE id = ?")
          .run(JSON.stringify(ThreadProviderMetadata.parse(thread)), thread.id);
      }
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
}
