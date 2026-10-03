import { migrateRunClient, prepareRunClient } from "./run-client-storage.ts";
import { executionWorkspace } from "./workspace-root.ts";
import {
  migrateThreadClient,
  seedThreadClient,
  encodeThreadClient,
  liveMetadataChange,
} from "./thread-client-storage.ts";
import { ThreadClientFields } from "@ace/protocol";
import { ThreadTransitionView } from "@ace/protocol";
import { ThreadProviderMetadata } from "@ace/protocol";
import { HistoryIndex } from "./history-index.ts";
import { setImmediate } from "node:timers/promises";
import type { ArchiveReader } from "@ace/history-import";
import { installArchive, readHistoryBlob } from "./history-storage.ts";
import { systemCredentials, type CredentialRuntime } from "./credential-runtime.ts";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type StatementSync, type SQLOutputValue } from "node:sqlite";
import {
  McpIntent,
  CommandResult,
  Event,
  Thread,
  DeviceId,
  type CommandId,
  type EventPayload,
  type RawPayload,
  ThreadId,
  type ItemId,
  type ThreadView,
  WorkspaceId,
  WorkspaceFileChange,
} from "@ace/protocol";
import { applyDelivery, updateThread } from "@ace/projection";
import { McpData } from "./mcp-data.ts";
import { Devices } from "./devices.ts";
import { migrate } from "./migrations.ts";
import { StatusStore } from "./status-store.ts";
import { UsageReplay } from "./usage-replay.ts";
import { PayloadStore } from "./payload-store.ts";

import { SearchIndex, SearchQueries, type SearchWorkerFactory } from "@ace/search";
import { scheduleSearch, type SearchScheduler } from "./search-runtime.ts";
import { BoundedCache } from "@ace/provider-kit/bounded-cache";

export interface StoreOptions extends Partial<CredentialRuntime> {
  /** Store owns and closes this SQLite connection when supplied. */
  database?: DatabaseSync;
  nextId?: () => string;
  now?: () => number;
  searchScheduler?: SearchScheduler;
  searchWorkerFactory?: SearchWorkerFactory;
}
type Listener = (events: Event[]) => void;
export class Store {
  readonly devices: Devices;
  private readonly db: DatabaseSync;
  private readonly usageReplay: UsageReplay;
  private readonly usageListeners = new Set<() => void>();
  readonly search: SearchIndex;
  readonly searchQueries: SearchQueries;
  private readonly searchAbort = new AbortController();
  private readonly stopSearchTimer: () => void;
  private closing: Promise<void> | undefined;
  private readonly payloads: PayloadStore;
  private readonly history: HistoryIndex;
  private readonly status: StatusStore;
  private readonly nextId: () => string;
  private readonly now: () => number;
  private readonly mcp: McpData;
  private engineSessionsKnown = false;
  private statements = new BoundedCache<string, StatementSync>(256, 256);
  private transactionEvents: Event[] | undefined;
  private depth = 0;
  private installingHistory = false;
  private historyWriting = false;
  private listeners = new Set<Listener>();
  private caches = new Map<ThreadId, { view: ThreadView; refs: number }>();
  private publications: Event[][] = [];
  private publishing = false;
  constructor(
    path: string,
    onError: (error: unknown) => void = console.error,
    options: StoreOptions = {},
  ) {
    this.onError = onError;
    this.db = options.database ?? new DatabaseSync(path);
    this.nextId = options.nextId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.payloads = new PayloadStore(this.db, this.nextId, (sql) => this.statement(sql));
    this.status = new StatusStore(this.db, (sql) => this.statement(sql));
    try {
      this.db.exec(
        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA wal_autocheckpoint=256;",
      );
      migrate(this.db);
      this.atomic(migrateThreadClient);
      this.usageReplay = new UsageReplay(this.db);
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS threads_update_blockers ON threads(id) WHERE json_extract(status, '$.state') NOT IN ('done', 'new', 'failed')`,
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS threads_workspace_live ON threads(workspace_id, archived_at, id)",
      );
      this.payloads.initialize();
      this.history = new HistoryIndex(
        this.db,
        (sql) => this.statement(sql),
        (stream, offset, limit) => this.payloads.readOutputBytes(stream, offset, limit),
        (thread, item, stream, offset, text) =>
          this.payloads.archiveOutput(thread, item, stream, offset, text),
      );
      this.history.initialize();
      this.status.initialize((id) => this.getThread(id));
      this.atomic(migrateRunClient);
      this.atomic((db) => seedThreadClient(db, (id) => this.getThread(id)));
      this.devices = new Devices(this.db, {
        id: options.id ?? this.nextId,
        randomBytes: options.randomBytes ?? systemCredentials.randomBytes,
      });
      this.mcp = new McpData(this.db, (id) => this.getThread(id));
      this.search = new SearchIndex(this.db, {
        readOutput: (threadId, streamId, offset, limit) => {
          if (this.payloads.streamThread(streamId) !== threadId) return undefined;
          return this.payloads.readOutputBytes(streamId, offset, limit).bytes;
        },
      });
      this.searchQueries = new SearchQueries(path, options.searchWorkerFactory);
      this.stopSearchTimer = (options.searchScheduler ?? scheduleSearch)(() => {
        try {
          this.search.flush();
        } catch (error) {
          this.onError(error);
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
    void this.search.backfill(this, { signal: this.searchAbort.signal }).catch(this.onError);
  }
  private onError: (error: unknown) => void;
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const finished = Promise.withResolvers<void>();
    this.closing = finished.promise;
    this.searchAbort.abort();
    const workers = this.searchQueries.close();
    let failure: unknown;
    try {
      this.stopSearchTimer();
    } catch (error) {
      failure = error;
    }
    this.statements.clear();
    this.listeners.clear();
    this.usageListeners.clear();
    this.caches.clear();
    try {
      this.db.close();
    } catch (error) {
      failure ??= error;
    }
    void workers.then(() => {
      if (failure !== undefined) finished.reject(failure);
      else finished.resolve();
    }, finished.reject);
    return this.closing;
  }
  /** Shared per-connection prepared statements; SQL text, never entity IDs, keys the bounded LRU. */
  statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement, 1);
    }
    return statement;
  }
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Wake analytics on committed events and durable deletion tombstones. */
  subscribeUsage(listener: () => void): () => void {
    if (this.usageListeners.size >= 16 && !this.usageListeners.has(listener))
      throw new Error("Usage subscription capacity reached");
    this.usageListeners.add(listener);
    return () => {
      this.usageListeners.delete(listener);
    };
  }
  headSeq(): number {
    return Number(this.statement("SELECT seq FROM host_sequence WHERE id = 1").get()?.seq);
  }
  private transaction<T>(run: () => T): T {
    if (this.installingHistory) return run();
    if (this.historyWriting) throw new Error("History publication in progress");
    if (this.transactionEvents) {
      const length = this.transactionEvents.length;
      const savepoint = `nested_${++this.depth}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = run();
        this.db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        this.transactionEvents.length = length;
        throw error;
      } finally {
        this.depth--;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionEvents = [];
    let result: T;
    let events: Event[];
    try {
      result = run();
      if (result instanceof Promise) throw new Error("Store transactions must be synchronous");
      events = this.transactionEvents;
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionEvents = undefined;
    }
    this.publish(events);
    for (const listener of this.usageListeners) {
      try {
        listener();
      } catch (error) {
        try {
          this.onError(error);
        } catch {
          /* committed */
        }
      }
    }
    return result;
  }
  /** Extend a receipt or event transaction on the same connection. No async I/O. */
  atomic<T>(run: (db: DatabaseSync) => T): T {
    return this.transaction(() => run(this.db));
  }
  /** Cap provider facts using the same blob owner and transaction as canonical events. */
  capRaw(raw: RawPayload[], threadId: ThreadId): RawPayload[] {
    return this.transaction(() => this.payloads.capRaw(raw, threadId));
  }
  private publish(events: Event[]): void {
    if (!events.length) return;
    this.publications.push(events);
    if (this.publishing) return;
    this.publishing = true;
    try {
      let batch: Event[] | undefined;
      while ((batch = this.publications.shift())) {
        for (const { view } of this.caches.values())
          applyDelivery(view, {
            type: "events",
            subscriptionId: "cache",
            afterSeq: view.seq,
            throughSeq: batch.at(-1)?.seq ?? view.seq,
            events: batch.filter(
              (event) =>
                event.threadId === view.thread.id && !event.payload.type.startsWith("item."),
            ),
          });
        const listeners = [...this.listeners];
        for (const listener of listeners) {
          try {
            listener(batch);
          } catch (error) {
            try {
              this.onError(error);
            } catch {
              /* Reporting must not disrupt committed delivery. */
            }
          }
        }
      }
    } finally {
      this.publishing = false;
    }
  }
  setHistoryWriting(active: boolean): void {
    if (active && this.historyWriting) throw new Error("History publication in progress");
    this.historyWriting = active;
    // Main-thread writes fail immediately while the worker holds the import transaction.
    this.db.exec(active ? "PRAGMA busy_timeout=0" : "PRAGMA busy_timeout=5000");
  }
  installHistory(archive: ArchiveReader, at: number, cancelled: () => boolean): void {
    if (this.transactionEvents || this.installingHistory) throw new Error("Store is busy");
    this.db.exec("BEGIN IMMEDIATE");
    this.installingHistory = true;
    try {
      installArchive(
        this.db,
        archive,
        (payload) => {
          this.appendEvents(archive.thread.id, [payload], at);
        },
        cancelled,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.installingHistory = false;
    }
  }
  async notifyHistory(after: number): Promise<void> {
    const through = this.headSeq();
    while (after < through) {
      const events = this.readEvents({ afterSeq: after, limit: 16 });
      if (!events.length) throw new Error("Missing committed history events");
      this.publish(events);
      after = events.at(-1)?.seq ?? through;
      await setImmediate();
    }
  }
  getWorkspace(id: WorkspaceId): { path: string; name: string } | undefined {
    const row = this.statement("SELECT path,name FROM workspaces WHERE id=?").get(id);
    return row ? { path: String(row.path), name: String(row.name) } : undefined;
  }
  executionWorkspace(id: ThreadId) {
    const thread = this.getThread(id);
    if (!thread) throw new Error("thread_not_found");
    if (!this.engineSessionsKnown)
      this.engineSessionsKnown = Boolean(
        this.statement(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='engine_sessions'",
        ).get(),
      );
    const session = this.engineSessionsKnown
      ? this.statement("SELECT * FROM engine_sessions WHERE thread_id=?").get(id)
      : undefined;
    return executionWorkspace(
      thread,
      session,
      session === undefined ? this.getWorkspacePath(thread.workspaceId) : undefined,
    );
  }
  completeWorkspacePreparation(id: ThreadId, expectedPath: string, path: string): boolean {
    const thread = this.getThread(id);
    if (!thread || thread.deletedAt !== undefined) return false;
    const result = this.statement(
      "UPDATE engine_sessions SET cwd=?,workspace_ready=1 WHERE thread_id=? AND cwd=? AND workspace_ready=0",
    ).run(path, id, expectedPath);
    return result.changes === 1;
  }
  importedSource(sourceId: string): Thread | undefined {
    const row = this.statement(
      "SELECT * FROM threads WHERE json_extract(imported,'$.sourceId')=?",
    ).get(sourceId);
    return row ? this.decodeThread(row) : undefined;
  }
  createWorkspace(path: string, name: string, at = this.now()): WorkspaceId {
    if (this.historyWriting) throw new Error("History publication in progress");
    const existing = this.statement("SELECT id FROM workspaces WHERE path = ?").get(path);
    if (existing) return WorkspaceId.parse(existing.id);
    const id = WorkspaceId.parse(this.nextId());
    this.statement("INSERT INTO workspaces VALUES (?, ?, ?, ?)").run(id, path, name, at);
    return id;
  }
  getWorkspacePath(id: WorkspaceId): string | undefined {
    const row = this.statement("SELECT path FROM workspaces WHERE id = ?").get(id);
    return typeof row?.path === "string" ? row.path : undefined;
  }
  /** Indexed fan-out to current workspace threads; never scan event or transcript history. */
  recordWorkspaceFileChange(workspaceId: WorkspaceId, input: WorkspaceFileChange): void {
    const change = WorkspaceFileChange.parse(input);
    let after = "";
    for (;;) {
      const rows = this.statement(
        "SELECT id FROM threads WHERE workspace_id=? AND archived_at IS NULL AND json_extract(client,'$.deletedAt') IS NULL AND id>? ORDER BY id LIMIT 64",
      ).all(workspaceId, after);
      if (!rows.length) return;
      this.transaction(() => {
        for (const row of rows) {
          const id = ThreadId.parse(row.id);
          this.appendEvents(id, [{ type: "workspace.files_changed", workspaceId, change }]);
          after = id;
        }
      });
    }
  }
  getThread(id: ThreadId): Thread | undefined {
    const row = this.statement("SELECT * FROM threads WHERE id = ?").get(id);
    if (!row) return undefined;
    return this.decodeThread(row);
  }
  private decodeThread(row: Record<string, SQLOutputValue>): Thread {
    return Thread.parse({
      ...(row.client == null ? {} : ThreadClientFields.parse(JSON.parse(String(row.client)))),
      ...(row.transitions == null
        ? {}
        : ThreadTransitionView.parse(JSON.parse(String(row.transitions)))),
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      provider: row.provider,
      ...(row.provider_metadata == null
        ? {}
        : Thread.pick({ backend: true, capabilities: true, handoff: true }).parse(
            JSON.parse(String(row.provider_metadata)),
          )),
      ...(row.acp == null ? {} : ThreadProviderMetadata.parse(JSON.parse(String(row.acp)))),
      status: JSON.parse(String(row.status)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
      ...(row.imported == null ? {} : { imported: JSON.parse(String(row.imported)) }),
      ...(row.root_agent_id === null ? {} : { rootAgentId: row.root_agent_id }),
    });
  }
  updateBlockers(): number {
    return Number(
      this.statement(
        "SELECT COUNT(*) AS n FROM threads WHERE json_extract(status, '$.state') NOT IN ('done', 'new', 'failed')",
      ).get()?.n,
    );
  }
  listThreads(): Thread[] {
    return this.statement("SELECT * FROM threads ORDER BY updated_at DESC, id")
      .all()
      .map((row) => this.decodeThread(row));
  }
  appendEvents(threadId: ThreadId, payloads: EventPayload[], at = this.now()): Event[] {
    return this.transaction(() => {
      let seq = this.headSeq();
      const events: Event[] = [];
      let followup: EventPayload | undefined;
      let inputIndex = 0;
      while (followup || inputIndex < payloads.length) {
        const payload = followup ?? payloads[inputIndex++];
        followup = undefined;
        if (!payload) break;
        const previous = this.getThread(threadId);
        const prepared = previous ? prepareRunClient(this.db, previous, payload) : payload;
        const event = Event.parse({
          seq: ++seq,
          id: this.nextId(),
          threadId,
          at,
          payload: prepared,
        });
        if (!Number.isSafeInteger(seq)) throw new Error("Sequence exhausted");
        let thread: Thread;
        if (event.payload.type === "thread.created") {
          thread = event.payload.thread;
          if (thread.id !== threadId || this.getThread(threadId))
            throw new Error("Invalid thread creation");
          this.statement(
            "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at, imported) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(
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
          const existing = this.getThread(threadId);
          if (!existing) throw new Error("Unknown thread");
          thread = existing;
        }
        const liveChange = liveMetadataChange(this.db, thread, event.payload);
        if (liveChange) followup = liveChange;
        updateThread(thread, event);
        if (
          event.payload.type === "thread.created" ||
          event.payload.type === "thread.client.updated"
        )
          this.statement("UPDATE threads SET client=? WHERE id=?").run(
            encodeThreadClient(thread),
            thread.id,
          );
        this.statement(
          "UPDATE threads SET title = ?, status = ?, updated_at = ?, archived_at = ?, root_agent_id = ?, provider = ?, transitions = ?, provider_metadata = ? WHERE id = ?",
        ).run(
          thread.title,
          JSON.stringify(thread.status),
          thread.updatedAt,
          thread.archivedAt ?? null,
          thread.rootAgentId ?? null,
          thread.provider,
          JSON.stringify({
            lineage: thread.lineage,
            execution: thread.execution,
            switch: thread.switch,
          }),
          JSON.stringify({
            backend: thread.backend,
            capabilities: thread.capabilities,
            handoff: thread.handoff,
          }),
          thread.id,
        );
        if (
          event.payload.type === "thread.created" ||
          (event.payload.type === "thread.updated" &&
            (event.payload.effectiveCapabilities !== undefined ||
              event.payload.acpSupport !== undefined))
        ) {
          this.statement("UPDATE threads SET acp = ? WHERE id = ?").run(
            JSON.stringify(ThreadProviderMetadata.parse(thread)),
            thread.id,
          );
        }
        event.payload = this.payloads.cap(event.payload, threadId);
        this.payloads.persist(event);
        this.history.record(event);
        this.status.persist(event, thread);
        this.statement("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)").run(
          seq,
          event.id,
          threadId,
          at,
          event.payload.type,
          JSON.stringify(event.payload),
        );
        this.statement("UPDATE host_sequence SET seq = ? WHERE id = 1").run(seq);
        this.mcp.apply(event, thread);
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
        const current = this.getThread(threadId);
        if (current?.deletedAt !== undefined) this.search.deleteThread(threadId);
        else if (current) this.search.observeThread(current, seq);
      }
      this.search.append(events);
      this.transactionEvents?.push(...events);
      return events;
    });
  }
  enqueueMcpIntent(id: string, intent: McpIntent, events: EventPayload[], at: number): void {
    const parsed = McpIntent.parse(intent);
    this.transaction(() => {
      if (!this.mcp.getAgent(parsed.threadId, parsed.agentId))
        throw new Error("Unknown MCP caller");
      this.mcp.enqueue(id, parsed);
      this.appendEvents(parsed.threadId, events, at);
    });
  }
  readMcpIntents(limit = 100) {
    return this.mcp.read(limit);
  }
  acknowledgeMcpIntent(id: string): boolean {
    return this.transaction(() => this.mcp.acknowledge(id));
  }
  getMcpAgent(threadId: ThreadId, agentId: string) {
    return this.mcp.getAgent(threadId, agentId);
  }
  listMcpAgents(threadId: ThreadId, cursor: string, limit: number) {
    return this.mcp.agents(threadId, cursor, limit);
  }
  readEvents(options: { afterSeq: number; threadId?: ThreadId; limit: number }): Event[] {
    const rows =
      options.threadId === undefined
        ? this.statement("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(
            options.afterSeq,
            options.limit,
          )
        : this.statement(
            "SELECT * FROM events WHERE seq > ? AND thread_id = ? ORDER BY seq LIMIT ?",
          ).all(options.afterSeq, options.threadId, options.limit);
    return rows.map((row) =>
      Event.parse({
        seq: row.seq,
        id: row.id,
        threadId: row.thread_id,
        at: row.at,
        payload: JSON.parse(String(row.payload)),
      }),
    );
  }
  /** Usage replay skips transcript/output payloads while advancing host coverage. */
  readUsagePage(options: { afterSeq: number; limit: number; maxBytes?: number }) {
    return this.usageReplay.read(options, this.headSeq());
  }
  recordCommand(commandId: CommandId, deviceId: DeviceId, run: () => CommandResult): CommandResult {
    return this.transaction(() => {
      const receipt = this.statement(
        "SELECT result,device_id FROM command_receipts WHERE command_id = ?",
      ).get(commandId);
      if (receipt) {
        if (DeviceId.parse(receipt.device_id) !== deviceId)
          return { commandId, ok: false, error: "forbidden" };
        return CommandResult.parse(JSON.parse(String(receipt.result)));
      }
      const result = CommandResult.parse(run());
      if (result.commandId !== commandId) throw new Error("Command result id mismatch");
      this.statement("INSERT INTO command_receipts VALUES (?, ?, ?, ?)").run(
        commandId,
        deviceId,
        this.now(),
        JSON.stringify(result),
      );
      return result;
    });
  }
  commandReceipt(commandId: CommandId, deviceId: DeviceId): CommandResult | undefined {
    const row = this.statement(
      "SELECT result FROM command_receipts WHERE command_id=? AND device_id=?",
    ).get(commandId, deviceId);
    return row ? CommandResult.parse(JSON.parse(String(row.result))) : undefined;
  }
  completeAsyncCommand(id: CommandId, input: CommandResult): CommandResult {
    const result = CommandResult.parse(input);
    if (result.commandId !== id) throw new Error("Command result id mismatch");
    return this.atomic((db) => {
      db.prepare(
        "UPDATE command_receipts SET result=? WHERE command_id=? AND json_extract(result,'$.error')='client_action_pending'",
      ).run(JSON.stringify(result), id);
      const row = db.prepare("SELECT result FROM command_receipts WHERE command_id=?").get(id);
      if (!row) throw new Error("Missing command reservation");
      return CommandResult.parse(JSON.parse(String(row.result)));
    });
  }
  releaseReviewCommand(commandId: CommandId, deviceId: DeviceId): void {
    this.statement(
      "DELETE FROM command_receipts WHERE command_id = ? AND device_id = ? AND json_extract(result, '$.error') = 'review_pending'",
    ).run(commandId, deviceId);
  }
  completeReviewCommand(
    commandId: CommandId,
    deviceId: DeviceId,
    input: CommandResult,
  ): CommandResult {
    const result = CommandResult.parse(input);
    if (result.commandId !== commandId) throw new Error("Command result id mismatch");
    return this.transaction(() => {
      this.statement(
        "UPDATE command_receipts SET result = ? WHERE command_id = ? AND device_id = ? AND json_extract(result, '$.error') = 'review_pending'",
      ).run(JSON.stringify(result), commandId, deviceId);
      const row = this.statement("SELECT result FROM command_receipts WHERE command_id = ?").get(
        commandId,
      );
      if (!row) throw new Error("Missing review command reservation");
      return CommandResult.parse(JSON.parse(String(row.result)));
    });
  }
  acquireThread(id: ThreadId): ThreadView {
    const cached = this.caches.get(id);
    if (cached) {
      this.catchUp(cached.view, id);
      cached.refs++;
      return cached.view;
    }
    const thread = this.getThread(id);
    if (!thread) throw new Error("Unknown thread");
    const view = this.status.snapshot(thread, this.headSeq());
    this.caches.set(id, { view, refs: 1 });
    return view;
  }
  private catchUp(view: ThreadView, id: ThreadId): void {
    const head = this.headSeq();
    if (view.seq < head) {
      const thread = this.getThread(id);
      if (!thread) throw new Error("Unknown thread");
      Object.assign(view, this.status.snapshot(thread, head));
    }
  }
  snapshotThread(id: ThreadId): ThreadView {
    const status = this.acquireThread(id);
    try {
      const view: ThreadView = structuredClone({ ...status, items: {}, itemOrder: [] });
      const page = this.payloads.page(id, this.headSeq() + 1, 200, 1024 * 1024);
      view.items = Object.fromEntries(page.items.map((item) => [item.id, item]));
      view.itemOrder = page.items.map((item) => item.id);
      view.itemsBefore = page.itemsBefore;
      if (page.itemSeqs) view.itemSeqs = page.itemSeqs;
      return view;
    } finally {
      this.releaseThread(id);
    }
  }
  getInteraction(id: string) {
    return this.status.interaction(id);
  }
  readItems(threadId: ThreadId, before: number, limit: number) {
    if (!this.getThread(threadId)) throw new Error("Unknown thread");
    return { ...this.payloads.page(threadId, before, limit), seq: this.headSeq() };
  }
  outputThread(streamId: string) {
    return this.payloads.liveStreamThread(streamId);
  }
  readItemPage(threadId: ThreadId, before: number, limit: number, byteLimit = 1024 * 1024) {
    if (!this.getThread(threadId)) throw new Error("Unknown thread");
    return { ...this.payloads.wirePage(threadId, before, limit, byteLimit), seq: this.headSeq() };
  }
  appendRawChunk(threadId: ThreadId, chunk: unknown): void {
    this.payloads.streamed.append(threadId, chunk);
  }
  readRawChunk(blobRef: string, offset: number, limit: number): Uint8Array {
    return this.payloads.streamed.read(blobRef, offset, limit);
  }
  historicalItemCount(threadId: ThreadId, through: number): number {
    return this.history.count(threadId, through);
  }
  historicalItemCompletion(threadId: ThreadId, itemId: ItemId) {
    return this.history.completion(threadId, itemId);
  }
  readHistoricalItemPage(
    threadId: ThreadId,
    through: number,
    before: number,
    limit: number,
    byteLimit = 1024 * 1024,
  ) {
    if (!this.getThread(threadId)) throw new Error("Unknown thread");
    return this.history.page(threadId, through, before, limit, byteLimit);
  }
  readHistoricalStream(
    threadId: ThreadId,
    streamId: string,
    through: number,
    offset: number,
    limit: number,
  ) {
    return this.history.readStream(threadId, streamId, through, offset, limit);
  }
  blobInfo(blobRef: string) {
    return this.payloads.blobInfo(blobRef);
  }
  outputInfo(streamId: string) {
    return this.payloads.outputInfo(streamId);
  }
  readOutputBytes(streamId: string, offset: number, limit: number) {
    return this.payloads.readLiveOutputBytes(streamId, offset, limit);
  }
  readOutput(streamId: string, offset: number, limit: number) {
    return this.payloads.readOutput(streamId, offset, limit);
  }
  readHistoryBlob(threadId: ThreadId, id: string, offset: number, limit: number) {
    if (!this.getThread(threadId)) throw new Error("Unknown thread");
    return readHistoryBlob(this.db, threadId, id, offset, limit);
  }
  deleteThread(id: ThreadId): void {
    this.transaction(() => {
      if (!this.getThread(id)) return;
      const seq = this.headSeq() + 1;
      if (!Number.isSafeInteger(seq)) throw new Error("Sequence exhausted");
      this.statement("INSERT INTO usage_deletions VALUES (?, ?, ?)").run(seq, id, this.now());
      this.statement("UPDATE host_sequence SET seq=? WHERE id=1").run(seq);
      this.search.deleteThread(id);
      this.mcp.deleteThread(id);
      this.statement("DELETE FROM events WHERE thread_id = ?").run(id);
      this.statement("DELETE FROM threads WHERE id = ?").run(id);
    });
    this.caches.delete(id);
  }
  releaseThread(id: ThreadId): void {
    const cached = this.caches.get(id);
    if (cached && --cached.refs === 0) this.caches.delete(id);
  }
}
