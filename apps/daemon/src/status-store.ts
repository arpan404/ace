import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  QueueState,
  Interaction,
  Event,
  ThreadView,
  type EventPayload,
  type Thread,
  type ThreadId,
} from "@ace/protocol";
import {
  applyEvent,
  createThreadView,
  rebuildAgentChildren,
  usageSnapshotKey,
} from "@ace/projection";
type Collection =
  | "agents"
  | "runs"
  | "interactions"
  | "backgroundTasks"
  | "usage"
  | "contextMeters"
  | "usageSnapshots";
function target(p: EventPayload): { collection: Collection; id: string } | undefined {
  switch (p.type) {
    case "agent.created":
      return { collection: "agents", id: p.agent.id };
    case "agent.updated":
    case "agent.status":
      return { collection: "agents", id: p.agentId };
    case "run.started":
      return { collection: "runs", id: p.run.id };
    case "run.client.updated":
    case "run.ended":
      return { collection: "runs", id: p.runId };
    case "interaction.opened":
      return { collection: "interactions", id: p.interaction.id };
    case "permission.reviewed":
      return { collection: "interactions", id: p.review.interactionId };
    case "interaction.closed":
      return { collection: "interactions", id: p.interactionId };
    case "background_task.started":
      return { collection: "backgroundTasks", id: p.task.id };
    case "background_task.updated":
      return { collection: "backgroundTasks", id: p.taskId };
    case "context_meter.updated":
      return { collection: "contextMeters", id: p.meter.agentId };
    case "usage.updated":
      return p.usageScope === "provider_session" || p.usageScope === "model_session"
        ? { collection: "usageSnapshots", id: usageSnapshotKey(p) }
        : { collection: "usage", id: p.agentId };
    default:
      return undefined;
  }
}
/** Materialized work entities, independent of transcript history. Canonical folding owns updates. */
export class StatusStore {
  private readonly db: DatabaseSync;
  private interactionRead: StatementSync | undefined;
  private statement: (sql: string) => StatementSync;
  constructor(
    db: DatabaseSync,
    statement: (sql: string) => StatementSync = (sql) => db.prepare(sql),
  ) {
    this.statement = statement;
    this.db = db;
  }
  initialize(getThread: (id: ThreadId) => Thread | undefined): void {
    this.db.exec("CREATE INDEX IF NOT EXISTS view_entity_ids ON view_entities(collection, id)");
    if (this.statement("SELECT id FROM status_migration WHERE id = 1").get()) {
      this.migrateUsage(getThread);
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of this.statement(
        "SELECT * FROM events WHERE type NOT IN ('item.created', 'item.updated', 'item.delta') ORDER BY seq",
      ).iterate()) {
        const input = {
          seq: row.seq,
          id: row.id,
          threadId: row.thread_id,
          at: row.at,
          payload: JSON.parse(String(row.payload)),
        };
        const parsed = Event.safeParse(input);
        if (!parsed.success && row.type === "usage.updated") continue;
        const event = parsed.success ? parsed.data : Event.parse(input);
        const thread = getThread(event.threadId);
        if (!thread) throw new Error("Unknown thread");
        this.persist(event, thread);
      }
      this.db.exec("INSERT INTO status_migration VALUES (1); COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.migrateUsage(getThread);
  }
  private migrateUsage(getThread: (id: ThreadId) => Thread | undefined): void {
    if (this.statement("SELECT id FROM status_migration WHERE id=2").get()) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Rebuild the previously agent-keyed materialization from retained usage only.
      // Stream rows at startup; malformed legacy snapshots remain in the raw log for replay omissions.
      this.db.exec("DELETE FROM view_entities WHERE collection IN ('usage', 'usageSnapshots')");
      for (const row of this.statement(
        "SELECT * FROM events WHERE type='usage.updated' ORDER BY seq",
      ).iterate()) {
        const parsed = Event.safeParse({
          seq: row.seq,
          id: row.id,
          threadId: row.thread_id,
          at: row.at,
          payload: JSON.parse(String(row.payload)),
        });
        if (!parsed.success) continue;
        const thread = getThread(parsed.data.threadId);
        if (thread) this.persist(parsed.data, thread);
      }
      this.db.exec("INSERT INTO status_migration VALUES (2); COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  persist(event: Event, thread: Thread): void {
    if (event.payload.type === "queue.updated") {
      const { type: _type, ...queue } = event.payload;
      this.statement(
        "INSERT INTO view_entities VALUES (?, 'queue', 'thread', ?) ON CONFLICT(thread_id,collection,id) DO UPDATE SET value=excluded.value",
      ).run(thread.id, JSON.stringify(queue));
      return;
    }
    const address = target(event.payload);
    if (!address) return;
    const { collection, id } = address;
    const view = createThreadView(thread, event.seq - 1);
    const previous = this.statement(
      "SELECT value FROM view_entities WHERE thread_id = ? AND collection = ? AND id = ?",
    ).get(thread.id, collection, id);
    if (previous)
      Object.assign(view, {
        [collection]: ThreadView.shape[collection].parse({
          [id]: JSON.parse(String(previous.value)),
        }),
      });
    applyEvent(view, event);
    const value = Object.hasOwn(view[collection] ?? {}, id) ? view[collection]?.[id] : undefined;
    if (value !== undefined)
      this.statement(
        "INSERT INTO view_entities VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, collection, id) DO UPDATE SET value = excluded.value",
      ).run(thread.id, collection, id, JSON.stringify(value));
  }
  interaction(id: string): Interaction | undefined {
    this.interactionRead ??= this.statement(
      "SELECT value FROM view_entities WHERE collection = 'interactions' AND id = ? LIMIT 1",
    );
    const row = this.interactionRead.get(id);
    return row ? Interaction.parse(JSON.parse(String(row.value))) : undefined;
  }
  snapshot(thread: Thread, seq: number): ThreadView {
    const input: Record<Collection, Record<string, unknown>> = {
      agents: {},
      runs: {},
      interactions: {},
      backgroundTasks: {},
      usage: {},
      contextMeters: {},
      usageSnapshots: {},
    };
    for (const row of this.statement(
      "SELECT collection, id, value FROM view_entities WHERE thread_id = ?",
    ).all(thread.id)) {
      const collection = String(row.collection);
      if (collection === "queue") continue;
      if (
        collection !== "agents" &&
        collection !== "runs" &&
        collection !== "interactions" &&
        collection !== "backgroundTasks" &&
        collection !== "usage" &&
        collection !== "contextMeters" &&
        collection !== "usageSnapshots"
      )
        throw new Error("Unknown entity collection");
      Object.defineProperty(input[collection], String(row.id), {
        value: JSON.parse(String(row.value)),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    const view = ThreadView.parse({ ...createThreadView(thread, seq), ...input });
    const queue = this.statement(
      "SELECT value FROM view_entities WHERE thread_id=? AND collection='queue'",
    ).get(thread.id);
    if (queue) view.queue = QueueState.parse(JSON.parse(String(queue.value)));
    rebuildAgentChildren(view);
    return view;
  }
}
