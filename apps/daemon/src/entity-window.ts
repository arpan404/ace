import type { StatementSync, DatabaseSync } from "node:sqlite";
import type { EntityCollection, ThreadView, Thread } from "@ace/protocol";
import { storedEntity, type EntityTrust, type StoredEntity } from "./stored-decode.ts";

const active = `CASE
 WHEN collection='agents' THEN json_extract(value,'$.origin')='root' OR json_extract(value,'$.status.state') IN ('starting','working','blocked','unresponsive')
 WHEN collection='runs' THEN json_extract(value,'$.state')='active'
 WHEN collection='interactions' THEN json_extract(value,'$.state')='pending'
 WHEN collection='backgroundTasks' THEN json_extract(value,'$.status') IN ('running','unknown')
 ELSE 0 END`;
const collections = ["agents", "runs", "interactions", "backgroundTasks"] as const;
export class EntityWindow {
  private sql: (sql: string) => StatementSync;
  private trust: EntityTrust;
  constructor(db: DatabaseSync, sql: (sql: string) => StatementSync, trust: EntityTrust) {
    this.sql = sql;
    this.trust = trust;
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
        values.push([String(row.id), storedEntity(collection, String(row.value), this.trust)]);
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
        recent.push([String(row.id), storedEntity(collection, String(row.value), this.trust)]);
        bytes += size;
        count++;
      }
      // Own data properties for every id, as decoding a record gives (`__proto__` included).
      Object.assign(view, {
        [collection]: Object.fromEntries([...recent.toReversed(), ...values]),
      });
      cursors[collection] = older ? (before ?? Number.MAX_SAFE_INTEGER) : null;
    }
    view.entitiesBefore = cursors;
    this.retainAgents(view);
  }
  metadata(threadId: string, collection: "usage" | "contextMeters") {
    return this.rows(threadId, collection, "1=1", "DESC LIMIT 200");
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
      const existing = Object.hasOwn(view.agents, id) ? view.agents[id] : undefined;
      const row = existing
        ? undefined
        : this.sql(
            "SELECT value FROM view_entities WHERE thread_id=? AND collection='agents' AND id=?",
          ).get(view.thread.id, id);
      const agent =
        existing ?? (row ? storedEntity("agents", String(row.value), this.trust) : undefined);
      if (!agent) continue;
      Object.defineProperty(view.agents, id, {
        value: agent,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      if (agent.parentId) agents.add(agent.parentId);
    }
  }
  record(threadId: string, collection: EntityCollection, id: string) {
    return this.sql(
      "SELECT e.value,w.created_seq FROM view_entities e JOIN view_entity_windows w USING(thread_id,collection,id) WHERE e.thread_id=? AND e.collection=? AND e.id=?",
    ).get(threadId, collection, id);
  }
  createdSeq(threadId: string, collection: EntityCollection, id: string): number {
    const row = this.sql(
      "SELECT created_seq FROM view_entity_windows WHERE thread_id=? AND collection=? AND id=?",
    ).get(threadId, collection, id);
    return row ? Number(row.created_seq) : 1;
  }
  /** A page of `collection`'s entities created before `before`; `seq` is the reader's to add. */
  page(thread: Pick<Thread, "id">, collection: EntityCollection, before: number, limit: number) {
    const page = { threadId: thread.id };
    // Each case narrows `collection`, so its entries are that collection's entities.
    switch (collection) {
      case "agents":
        return { ...page, collection, ...this.entries(thread, collection, before, limit) };
      case "runs":
        return { ...page, collection, ...this.entries(thread, collection, before, limit) };
      case "interactions":
        return { ...page, collection, ...this.entries(thread, collection, before, limit) };
      case "backgroundTasks":
        return { ...page, collection, ...this.entries(thread, collection, before, limit) };
    }
  }
  /** At most 200 entries, the most a page holds, and at most 128 KiB unless one entry is more. */
  private entries<C extends EntityCollection>(
    thread: Pick<Thread, "id">,
    collection: C,
    before: number,
    limit: number,
  ): { entries: StoredEntity<C>[]; entitiesBefore: number | null } {
    const most = Math.min(limit, 200);
    const entries: StoredEntity<C>[] = [];
    let bytes = 0;
    let oldest = before;
    let more = false;
    for (const row of this.rows(
      thread.id,
      collection,
      "w.created_seq<?",
      "DESC LIMIT ?",
      before,
      most + 1,
    )) {
      const size = Buffer.byteLength(String(row.value));
      if (entries.length >= most || (entries.length && bytes + size > 131072)) {
        more = true;
        break;
      }
      entries.push(storedEntity(collection, String(row.value), this.trust));
      bytes += size;
      oldest = Number(row.created_seq);
    }
    return { entries: entries.toReversed(), entitiesBefore: more ? oldest : null };
  }
}
