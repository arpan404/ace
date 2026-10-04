import type { StatementSync, DatabaseSync } from "node:sqlite";
import { ThreadId, type EntityCollection, ThreadView, type Thread } from "@ace/protocol";

const active = `CASE
 WHEN collection='agents' THEN json_extract(value,'$.origin')='root' OR json_extract(value,'$.status.state') IN ('starting','working','blocked','unresponsive')
 WHEN collection='runs' THEN json_extract(value,'$.state')='active'
 WHEN collection='interactions' THEN json_extract(value,'$.state')='pending'
 WHEN collection='backgroundTasks' THEN json_extract(value,'$.status') IN ('running','unknown')
 ELSE 0 END`;
const collections = ["agents", "runs", "interactions", "backgroundTasks"] as const;
export class EntityWindow {
  private sql: (sql: string) => StatementSync;
  constructor(db: DatabaseSync, sql: (sql: string) => StatementSync) {
    this.sql = sql;
    const existing = sql("SELECT 1 FROM sqlite_master WHERE name='view_entity_windows'").get();
    db.exec(`CREATE TABLE IF NOT EXISTS view_entity_windows (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      collection TEXT NOT NULL, id TEXT NOT NULL, created_seq INTEGER NOT NULL,
      active INTEGER NOT NULL, PRIMARY KEY(thread_id,collection,id)
    );
    CREATE INDEX IF NOT EXISTS entity_recent ON view_entity_windows(thread_id,collection,created_seq);
    CREATE INDEX IF NOT EXISTS entity_active ON view_entity_windows(thread_id,collection,active,created_seq);`);
    if (!existing)
      db.exec(
        `INSERT INTO view_entity_windows SELECT thread_id,collection,id,rowid,${active} FROM view_entities`,
      );
  }
  capture(threadId: string, collection: string, id: string, seq: number): void {
    this.sql(`INSERT INTO view_entity_windows SELECT thread_id,collection,id,?,${active} FROM view_entities WHERE thread_id=? AND collection=? AND id=?
      ON CONFLICT(thread_id,collection,id) DO UPDATE SET active=excluded.active`).run(
      seq,
      threadId,
      collection,
      id,
    );
  }
  private rows(
    thread: string,
    collection: string,
    predicate: string,
    order: string,
    ...args: number[]
  ) {
    return this.sql(`SELECT w.created_seq,e.id,e.value FROM view_entity_windows w JOIN view_entities e USING(thread_id,collection,id)
      WHERE w.thread_id=? AND w.collection=? AND ${predicate} ORDER BY w.created_seq ${order}`).iterate(
      thread,
      collection,
      ...args,
    );
  }
  fill(view: ThreadView): void {
    const cursors: Partial<Record<import("@ace/protocol").EntityCollection, number | null>> = {};
    for (const collection of collections) {
      const values: [string, unknown][] = [];
      for (const row of this.rows(view.thread.id, collection, "w.active=1", "ASC"))
        values.push([String(row.id), JSON.parse(String(row.value))]);
      let bytes = 0;
      let before: number | undefined;
      let count = 0;
      let older = false;
      const recent: [string, unknown][] = [];
      for (const row of this.rows(view.thread.id, collection, "w.active=0", "DESC LIMIT 201")) {
        const size = Buffer.byteLength(String(row.value));
        if (count >= 200 || bytes + size > 131072) {
          older = true;
          break;
        }
        before = Number(row.created_seq);
        recent.push([String(row.id), JSON.parse(String(row.value))]);
        bytes += size;
        count++;
      }
      Object.assign(view, {
        [collection]: ThreadView.shape[collection].parse(
          Object.fromEntries([...recent.toReversed(), ...values]),
        ),
      });
      cursors[collection] = older ? (before ?? Number.MAX_SAFE_INTEGER) : null;
    }
    view.entitiesBefore = cursors;
    this.retainAgents(view);
  }
  retainAgents(view: ThreadView): void {
    const agents = new Set(Object.keys(view.agents));
    for (const entity of [
      ...Object.values(view.items),
      ...Object.values(view.runs),
      ...Object.values(view.interactions),
      ...Object.values(view.backgroundTasks),
    ])
      if (entity.agentId) agents.add(entity.agentId);
    // Keep parents of retained agents, even if they settled years ago.
    for (const id of agents) {
      const row = this.sql(
        "SELECT value FROM view_entities WHERE thread_id=? AND collection='agents' AND id=?",
      ).get(view.thread.id, id);
      if (!row) continue;
      const agent = importAgent(row.value);
      Object.defineProperty(view.agents, id, {
        value: agent,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      if (agent.parentId) agents.add(agent.parentId);
    }
  }
  page(thread: Thread, collection: EntityCollection, before: number, limit: number) {
    const entries: unknown[] = [];
    let bytes = 0;
    let oldest = before;
    let more = false;
    for (const row of this.rows(
      thread.id,
      collection,
      "w.created_seq<?",
      "DESC LIMIT ?",
      before,
      Math.min(limit, 200) + 1,
    )) {
      const size = Buffer.byteLength(String(row.value));
      if (entries.length >= limit || (entries.length && bytes + size > 131072)) {
        more = true;
        break;
      }
      entries.push(JSON.parse(String(row.value)));
      bytes += size;
      oldest = Number(row.created_seq);
    }
    return {
      threadId: ThreadId.parse(thread.id),
      collection,
      entries: entries.toReversed(),
      entitiesBefore: more ? oldest : null,
    };
  }
}
import { Agent } from "@ace/protocol";
function importAgent(value: unknown) {
  return Agent.parse(JSON.parse(String(value)));
}
