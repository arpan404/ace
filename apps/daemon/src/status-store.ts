import type { DatabaseSync } from "node:sqlite";
import {
  Interaction,
  Event,
  ThreadView,
  type EventPayload,
  type Thread,
  type ThreadId,
} from "@ace/protocol";
import { applyEvent, createThreadView, rebuildAgentChildren } from "@ace/projection";
type Collection = "agents" | "runs" | "interactions" | "backgroundTasks" | "usage";
function target(p: EventPayload): { collection: Collection; id: string } | undefined {
  switch (p.type) {
    case "agent.created":
      return { collection: "agents", id: p.agent.id };
    case "agent.updated":
    case "agent.status":
      return { collection: "agents", id: p.agentId };
    case "run.started":
      return { collection: "runs", id: p.run.id };
    case "run.ended":
      return { collection: "runs", id: p.runId };
    case "interaction.opened":
      return { collection: "interactions", id: p.interaction.id };
    case "interaction.closed":
      return { collection: "interactions", id: p.interactionId };
    case "background_task.started":
      return { collection: "backgroundTasks", id: p.task.id };
    case "background_task.updated":
      return { collection: "backgroundTasks", id: p.taskId };
    case "usage.updated":
      return { collection: "usage", id: p.agentId };
    default:
      return undefined;
  }
}
/** Materialized work entities, independent of transcript history. Canonical folding owns updates. */
export class StatusStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  initialize(getThread: (id: ThreadId) => Thread | undefined): void {
    this.db.exec("CREATE INDEX IF NOT EXISTS view_entity_ids ON view_entities(collection, id)");
    if (this.db.prepare("SELECT id FROM status_migration WHERE id = 1").get()) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of this.db
        .prepare(
          "SELECT * FROM events WHERE type NOT IN ('item.created', 'item.updated', 'item.delta') ORDER BY seq",
        )
        .iterate()) {
        const event = Event.parse({
          seq: row.seq,
          id: row.id,
          threadId: row.thread_id,
          at: row.at,
          payload: JSON.parse(String(row.payload)),
        });
        const thread = getThread(event.threadId);
        if (!thread) throw new Error("Unknown thread");
        this.persist(event, thread);
      }
      this.db.exec("INSERT INTO status_migration VALUES (1); COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  persist(event: Event, thread: Thread): void {
    const address = target(event.payload);
    if (!address) return;
    const { collection, id } = address;
    const view = createThreadView(thread, event.seq - 1);
    const previous = this.db
      .prepare("SELECT value FROM view_entities WHERE thread_id = ? AND collection = ? AND id = ?")
      .get(thread.id, collection, id);
    if (previous)
      Object.assign(view, {
        [collection]: ThreadView.shape[collection].parse({
          [id]: JSON.parse(String(previous.value)),
        }),
      });
    applyEvent(view, event);
    const value = Object.hasOwn(view[collection], id) ? view[collection][id] : undefined;
    if (value !== undefined)
      this.db
        .prepare(
          "INSERT INTO view_entities VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, collection, id) DO UPDATE SET value = excluded.value",
        )
        .run(thread.id, collection, id, JSON.stringify(value));
  }
  interaction(id: string): Interaction | undefined {
    const row = this.db
      .prepare(
        "SELECT value FROM view_entities WHERE collection = 'interactions' AND id = ? LIMIT 1",
      )
      .get(id);
    return row ? Interaction.parse(JSON.parse(String(row.value))) : undefined;
  }
  snapshot(thread: Thread, seq: number): ThreadView {
    const input: Record<Collection, Record<string, unknown>> = {
      agents: {},
      runs: {},
      interactions: {},
      backgroundTasks: {},
      usage: {},
    };
    for (const row of this.db
      .prepare("SELECT collection, id, value FROM view_entities WHERE thread_id = ?")
      .all(thread.id)) {
      const collection = String(row.collection);
      if (
        collection !== "agents" &&
        collection !== "runs" &&
        collection !== "interactions" &&
        collection !== "backgroundTasks" &&
        collection !== "usage"
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
    rebuildAgentChildren(view);
    return view;
  }
}
