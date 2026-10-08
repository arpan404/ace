import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  Agent,
  Event,
  McpIntent,
  PendingMcpIntent,
  type Thread,
  type ThreadId,
} from "@ace/protocol";
import { applyEvent, createThreadView } from "@ace/projection";

/** SQLite projection and bounded durable outbox, participating in Store's transactions. */
export class McpData {
  private readonly db: DatabaseSync;
  private agent: StatementSync;
  private page: StatementSync;
  private upsert: StatementSync;
  private insert: StatementSync;
  private pending: StatementSync;
  private remove: StatementSync;
  private count: StatementSync;
  private increment: StatementSync;
  private decrement: StatementSync;
  constructor(db: DatabaseSync, thread: (id: ThreadId) => Thread | undefined) {
    this.db = db;
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS mcp_agents (thread_id TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(thread_id, id));
      CREATE TABLE IF NOT EXISTS mcp_intents (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mcp_intents_type ON mcp_intents(json_extract(payload, '$.type'));
      CREATE TABLE IF NOT EXISTS mcp_meta (id INTEGER PRIMARY KEY CHECK(id = 1), indexed INTEGER NOT NULL, pending INTEGER NOT NULL);
      INSERT OR IGNORE INTO mcp_meta VALUES (1, 0, 0);`);
    this.agent = db.prepare("SELECT payload FROM mcp_agents WHERE thread_id = ? AND id = ?");
    this.page = db.prepare(
      "SELECT payload FROM mcp_agents WHERE thread_id = ? AND id > ? ORDER BY id LIMIT ?",
    );
    this.upsert = db.prepare(
      "INSERT INTO mcp_agents VALUES (?, ?, ?) ON CONFLICT(thread_id, id) DO UPDATE SET payload = excluded.payload",
    );
    this.insert = db.prepare("INSERT INTO mcp_intents VALUES (?, ?, ?)");
    this.pending = db.prepare("SELECT id, payload FROM mcp_intents ORDER BY rowid LIMIT ?");
    this.remove = db.prepare("DELETE FROM mcp_intents WHERE id = ?");
    this.count = db.prepare("SELECT pending FROM mcp_meta WHERE id = 1");
    this.increment = db.prepare("UPDATE mcp_meta SET pending = pending + 1 WHERE id = 1");
    this.decrement = db.prepare("UPDATE mcp_meta SET pending = pending - 1 WHERE id = 1");
    try {
      if (!db.prepare("SELECT indexed FROM mcp_meta WHERE id = 1").get()?.indexed) {
        const rows = db
          .prepare(
            "SELECT * FROM events WHERE type IN ('agent.created', 'agent.updated', 'agent.status') ORDER BY seq",
          )
          .iterate();
        for (const row of rows) {
          const event = Event.parse({
            id: row.id,
            seq: row.seq,
            threadId: row.thread_id,
            at: row.at,
            payload: JSON.parse(String(row.payload)),
          });
          const owner = thread(event.threadId);
          if (owner) this.apply(event, owner);
        }
        db.exec("UPDATE mcp_meta SET indexed = 1 WHERE id = 1");
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  apply(event: Event, thread: Thread): void {
    const payload = event.payload;
    if (
      payload.type !== "agent.created" &&
      payload.type !== "agent.status" &&
      payload.type !== "agent.updated"
    )
      return;
    const id = payload.type === "agent.created" ? payload.agent.id : payload.agentId;
    const view = createThreadView(thread, event.seq - 1);
    const row = this.agent.get(event.threadId, id);
    if (row)
      Object.defineProperty(view.agents, id, {
        value: Agent.parse(JSON.parse(String(row.payload))),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    applyEvent(view, event);
    const agent = Object.hasOwn(view.agents, id) ? view.agents[id] : undefined;
    if (agent) {
      if (agent.threadId !== event.threadId) throw new Error("Agent thread mismatch");
      this.upsert.run(event.threadId, id, JSON.stringify(agent));
    }
  }
  deleteThread(threadId: ThreadId): void {
    const removed = this.db
      .prepare("DELETE FROM mcp_intents WHERE thread_id = ?")
      .run(threadId).changes;
    this.db.prepare("DELETE FROM mcp_agents WHERE thread_id = ?").run(threadId);
    this.db.prepare("UPDATE mcp_meta SET pending = pending - ? WHERE id = 1").run(removed);
  }
  getAgent(threadId: ThreadId, id: string): Agent | undefined {
    const row = this.agent.get(threadId, id);
    return row ? Agent.parse(JSON.parse(String(row.payload))) : undefined;
  }
  agents(threadId: ThreadId, cursor: string, limit: number): Agent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101)
      throw new Error("Invalid page limit");
    return this.page
      .all(threadId, cursor, limit)
      .map((row) => Agent.parse(JSON.parse(String(row.payload))));
  }
  enqueue(id: string, intent: McpIntent): void {
    const parsed = PendingMcpIntent.parse({ id, intent });
    if (Number(this.count.get()?.pending) >= 10_000) throw new Error("MCP intent capacity reached");
    this.insert.run(parsed.id, parsed.intent.threadId, JSON.stringify(parsed.intent));
    this.increment.run();
  }
  read(limit: number, type?: "mcp.notify"): PendingMcpIntent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Invalid intent limit");
    return (
      type
        ? this.db
            .prepare(
              "SELECT id, payload FROM mcp_intents WHERE json_extract(payload, '$.type')=? ORDER BY rowid LIMIT ?",
            )
            .all(type, limit)
        : this.pending.all(limit)
    ).map((row) => PendingMcpIntent.parse({ id: row.id, intent: JSON.parse(String(row.payload)) }));
  }
  acknowledge(id: string): boolean {
    if (this.remove.run(id).changes === 0) return false;
    this.decrement.run();
    return true;
  }
}
