import { EntityWindow } from "./entity-window.ts";
import { EntityRetention, retainedEntity } from "./entity-retention.ts";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  QueueState,
  Interaction,
  Event,
  ThreadView,
  type EventPayload,
  type Thread,
  type ThreadId,
  type EntityCollection,
  Agent,
} from "@ace/protocol";
import {
  applyEvent,
  createThreadView,
  rebuildAgentChildren,
  usageSnapshotKey,
  reparentAgent,
  updateThread,
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
  private window: EntityWindow | undefined;
  private interactionRead: StatementSync | undefined;
  private statement: (sql: string) => StatementSync;
  private retention = new WeakMap<ThreadView, EntityRetention>();
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
      this.window = new EntityWindow(this.db, this.statement);
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
    this.window = new EntityWindow(this.db, this.statement);
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
    if (value !== undefined) {
      this.statement(
        "INSERT INTO view_entities VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, collection, id) DO UPDATE SET value = excluded.value",
      ).run(thread.id, collection, id, JSON.stringify(value));
      this.window?.capture(thread.id, collection, id, event.seq);
    }
  }
  interaction(id: string): Interaction | undefined {
    this.interactionRead ??= this.statement(
      "SELECT value FROM view_entities WHERE collection = 'interactions' AND id = ? LIMIT 1",
    );
    const row = this.interactionRead.get(id);
    return row ? Interaction.parse(JSON.parse(String(row.value))) : undefined;
  }
  page(
    thread: Thread,
    collection: import("@ace/protocol").EntityCollection,
    before: number,
    limit: number,
  ) {
    if (!this.window) throw new Error("Entity windows not initialized");
    return this.window.page(thread, collection, before, limit);
  }
  retainItemAgents(view: ThreadView): void {
    this.window?.retainAgents(view);
    rebuildAgentChildren(view);
  }
  private seedRetention(view: ThreadView): EntityRetention {
    const policy = new EntityRetention();
    policy.seed(
      collections.flatMap((name) => {
        return Object.values(view[name]).map((value) =>
          retainedEntity(name, value, this.window?.createdSeq(view.thread.id, name, value.id) ?? 1),
        );
      }),
    );
    this.retention.set(view, policy);
    this.removeEvicted(view, policy);
    return policy;
  }
  private removeEvicted(view: ThreadView, policy: EntityRetention): void {
    for (const entry of policy.drain()) {
      if (entry.collection === "agents") {
        const agent = Object.hasOwn(view.agents, entry.id) ? view.agents[entry.id] : undefined;
        if (agent) reparentAgent(view, entry.id, agent.parentId, null);
      }
      delete view[entry.collection][entry.id];
      if (entry.collection === "agents") {
        const children = view.agentChildren[entry.id] ?? [];
        // A referenced parent never leaves the policy while a retained child needs it.
        if (!children.length) delete view.agentChildren[entry.id];
        delete view.usage[entry.id];
        if (view.contextMeters) delete view.contextMeters[entry.id];
      }
      view.entitiesBefore ??= {};
      view.entitiesBefore[entry.collection] = Math.max(
        view.entitiesBefore[entry.collection] ?? 0,
        policy.oldest(entry.collection) ?? 0,
        Math.min(Number.MAX_SAFE_INTEGER, entry.seq + 1),
      );
    }
  }
  updateCache(view: ThreadView, events: Event[]): void {
    const policy = this.retention.get(view) ?? this.seedRetention(view);
    const changed = new Map<string, { collection: Collection; id: string }>();
    for (const event of events) {
      const address = target(event.payload);
      if (address) changed.set(`${address.collection}:${address.id}`, address);
      if (event.payload.type.startsWith("thread.") || event.payload.type === "queue.updated")
        applyEvent(view, event);
      else updateThread(view.thread, event);
    }
    const restore = (collection: EntityCollection, id: string): void => {
      const row = this.window?.record(view.thread.id, collection, id);
      if (!row) return;
      const values = ThreadView.shape[collection].parse({ [id]: JSON.parse(String(row.value)) });
      const value = values[id];
      if (!value) return;
      if (collection === "agents") {
        const agent = Agent.parse(value);
        const previous = Object.hasOwn(view.agents, id) ? view.agents[id] : undefined;
        reparentAgent(view, id, previous?.parentId, agent.parentId);
        if (!previous) {
          for (const metadata of ["usage", "contextMeters"] as const) {
            const metadataRow = this.statement(
              "SELECT value FROM view_entities WHERE thread_id=? AND collection=? AND id=?",
            ).get(view.thread.id, metadata, id);
            if (!metadataRow) continue;
            const metadataValues = ThreadView.shape[metadata].parse({
              [id]: JSON.parse(String(metadataRow.value)),
            });
            const metadataValue = metadataValues?.[id];
            if (metadataValue !== undefined) setValue((view[metadata] ??= {}), id, metadataValue);
          }
        }
      }
      setValue(view[collection], id, value);
      const entry = retainedEntity(
        collection,
        value,
        Event.shape.seq.parse(Number(row.created_seq)),
      );
      policy.observe(entry);
      for (const agentId of entry.references)
        if (!policy.hasAgent(agentId)) restore("agents", agentId);
    };
    for (const { collection, id } of changed.values()) {
      if (
        collection === "agents" ||
        collection === "runs" ||
        collection === "interactions" ||
        collection === "backgroundTasks"
      )
        restore(collection, id);
      else {
        if (collection !== "usageSnapshots" && !policy.hasAgent(id)) continue;
        const row = this.statement(
          "SELECT value FROM view_entities WHERE thread_id=? AND collection=? AND id=?",
        ).get(view.thread.id, collection, id);
        if (row) {
          const values = ThreadView.shape[collection].parse({
            [id]: JSON.parse(String(row.value)),
          });
          const value = values?.[id];
          if (value !== undefined) setValue((view[collection] ??= {}), id, value);
        }
        if (collection === "usageSnapshots") {
          const ids = Object.keys(view.usageSnapshots);
          for (const older of ids.slice(0, Math.max(0, ids.length - 200)))
            delete view.usageSnapshots[older];
        }
      }
    }
    this.removeEvicted(view, policy);
  }
  replaceCache(view: ThreadView, source: ThreadView): void {
    Object.assign(view, source);
    const policy = this.retention.get(source);
    if (policy) this.retention.set(view, policy);
    else this.seedRetention(view);
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
    const view = ThreadView.parse({ ...createThreadView(thread, seq), ...input });
    this.window?.fill(view);
    const agentIds = Object.keys(view.agents);
    for (const collection of ["usage", "contextMeters"] as const) {
      for (const id of agentIds) {
        const row = this.statement(
          "SELECT value FROM view_entities WHERE thread_id=? AND collection=? AND id=?",
        ).get(thread.id, collection, id);
        if (row)
          Object.assign(
            input[collection],
            Object.fromEntries([[id, JSON.parse(String(row.value))]]),
          );
      }
      Object.assign(view, { [collection]: ThreadView.shape[collection].parse(input[collection]) });
    }
    for (const row of this.statement(
      "SELECT id,value FROM view_entities WHERE thread_id=? AND collection='usageSnapshots' ORDER BY rowid DESC LIMIT 200",
    ).iterate(thread.id))
      input.usageSnapshots[String(row.id)] = JSON.parse(String(row.value));
    view.usageSnapshots = ThreadView.shape.usageSnapshots.parse(input.usageSnapshots);
    const queue = this.statement(
      "SELECT value FROM view_entities WHERE thread_id=? AND collection='queue'",
    ).get(thread.id);
    if (queue) view.queue = QueueState.parse(JSON.parse(String(queue.value)));
    rebuildAgentChildren(view);
    this.seedRetention(view);
    return view;
  }
}
const collections = ["agents", "runs", "interactions", "backgroundTasks"] as const;
function setValue(record: object, id: string, value: unknown): void {
  Object.defineProperty(record, id, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
