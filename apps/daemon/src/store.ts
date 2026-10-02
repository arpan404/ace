import { systemCredentials, type CredentialRuntime } from "./credential-runtime.ts";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type StatementSync, type SQLOutputValue } from "node:sqlite";
import {
  McpIntent,
  CommandResult,
  Event,
  Thread,
  type DeviceId,
  type CommandId,
  type EventPayload,
  type ThreadId,
  type ThreadView,
  WorkspaceId,
} from "@ace/protocol";
import { McpData } from "./mcp-data.ts";
import { applyDelivery, updateThread } from "@ace/projection";
import { Devices } from "./devices.ts";
import { migrate } from "./migrations.ts";
import { StatusStore } from "./status-store.ts";
import { PayloadStore } from "./payload-store.ts";

export interface StoreOptions extends Partial<CredentialRuntime> {
  /** Store owns and closes this SQLite connection when supplied. */
  database?: DatabaseSync;
  nextId?: () => string;
  now?: () => number;
}
type Listener = (events: Event[]) => void;
export class Store {
  readonly devices: Devices;
  private readonly db: DatabaseSync;
  private readonly payloads: PayloadStore;
  private readonly status: StatusStore;
  private readonly nextId: () => string;
  private readonly now: () => number;
  private readonly mcp: McpData;
  private readonly payloads: PayloadStore;
  private readonly status: StatusStore;
  private readonly nextId: () => string;
  private readonly now: () => number;
  private statements = new Map<string, StatementSync>();
  private closed = false;
  private transactionEvents: Event[] | undefined;
  private depth = 0;
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
    this.payloads = new PayloadStore(this.db, this.nextId);
    this.status = new StatusStore(this.db);
    try {
      this.db.exec(
        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
      );
      migrate(this.db);
      this.payloads.initialize();
      this.status.initialize((id) => this.getThread(id));
      this.devices = new Devices(this.db, {
        id: options.id ?? this.nextId,
        randomBytes: options.randomBytes ?? systemCredentials.randomBytes,
      });
      this.mcp = new McpData(this.db, (id) => this.getThread(id));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private onError: (error: unknown) => void;
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.listeners.clear();
    this.caches.clear();
    this.db.close();
  }
  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  headSeq(): number {
    return Number(this.statement("SELECT seq FROM host_sequence WHERE id = 1").get()?.seq);
  }
  private transaction<T>(run: () => T): T {
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
    return result;
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
  createWorkspace(path: string, name: string, at = this.now()): WorkspaceId {
    const existing = this.statement("SELECT id FROM workspaces WHERE path = ?").get(path);
    if (existing) return WorkspaceId.parse(existing.id);
    const id = WorkspaceId.parse(this.nextId());
    this.statement("INSERT INTO workspaces VALUES (?, ?, ?, ?)").run(id, path, name, at);
    return id;
  }
  getThread(id: ThreadId): Thread | undefined {
    const row = this.statement("SELECT * FROM threads WHERE id = ?").get(id);
    if (!row) return undefined;
    return this.decodeThread(row);
  }
  private decodeThread(row: Record<string, SQLOutputValue>): Thread {
    return Thread.parse({
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      provider: row.provider,
      status: JSON.parse(String(row.status)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
      ...(row.root_agent_id === null ? {} : { rootAgentId: row.root_agent_id }),
    });
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
      for (const payload of payloads) {
        const event = Event.parse({ seq: ++seq, id: this.nextId(), threadId, at, payload });
        if (!Number.isSafeInteger(seq)) throw new Error("Sequence exhausted");
        let thread: Thread;
        if (event.payload.type === "thread.created") {
          thread = event.payload.thread;
          if (thread.id !== threadId || this.getThread(threadId))
            throw new Error("Invalid thread creation");
          this.statement(
            "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).run(
            thread.id,
            thread.workspaceId,
            thread.title,
            thread.provider,
            JSON.stringify(thread.status),
            thread.createdAt,
            event.at,
          );
        } else {
          const existing = this.getThread(threadId);
          if (!existing) throw new Error("Unknown thread");
          thread = existing;
        }
        updateThread(thread, event);
        this.statement(
          "UPDATE threads SET title = ?, status = ?, updated_at = ?, archived_at = ?, root_agent_id = ? WHERE id = ?",
        ).run(
          thread.title,
          JSON.stringify(thread.status),
          thread.updatedAt,
          thread.archivedAt ?? null,
          thread.rootAgentId ?? null,
          thread.id,
        );
        event.payload = this.payloads.cap(event.payload, threadId);
        this.payloads.persist(event);
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
        this.statement("UPDATE host_sequence SET seq = ? WHERE id = 1").run(seq);
        events.push(event);
      }
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
  recordCommand(commandId: CommandId, deviceId: DeviceId, run: () => CommandResult): CommandResult {
    return this.transaction(() => {
      const receipt = this.statement(
        "SELECT result FROM command_receipts WHERE command_id = ?",
      ).get(commandId);
      if (receipt) return CommandResult.parse(JSON.parse(String(receipt.result)));
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
    return this.payloads.streamThread(streamId);
  }
  readOutput(streamId: string, offset: number, limit: number) {
    return this.payloads.readOutput(streamId, offset, limit);
  }
  deleteThread(id: ThreadId): void {
    this.transaction(() => {
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
