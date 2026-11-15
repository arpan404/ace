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
/** The bytes of entries a page holds unless the reader asks for less (`maxBytes`). */
export const entityPageBytes = 128 * 1024;
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
  page(
    thread: Pick<Thread, "id">,
    collection: EntityCollection,
    before: number,
    limit: number,
    maxBytes = entityPageBytes,
  ) {
    const page = { threadId: thread.id };
    // Each case narrows `collection`, so its entries are that collection's entities.
    switch (collection) {
      case "agents":
        return {
          ...page,
          collection,
          ...this.entries(thread, collection, before, limit, maxBytes),
        };
      case "runs":
        return {
          ...page,
          collection,
          ...this.entries(thread, collection, before, limit, maxBytes),
        };
      case "interactions":
        return {
          ...page,
          collection,
          ...this.entries(thread, collection, before, limit, maxBytes),
        };
      case "backgroundTasks":
        return {
          ...page,
          collection,
          ...this.entries(thread, collection, before, limit, maxBytes),
        };
    }
  }
  /**
   * At most 200 entries, the most a page holds, and at most `maxBytes` (128 KiB unless the reader
   * asked for less) unless one entry is more.
   *
   * The newest page (`before` at the end of time) carries every active entity first, whatever
   * its age, as a snapshot's window does (`fill`): a pending request is never behind pages of
   * resolved ones, for a reader that stops after a few pages (installed phones read four).
   * Older pages then hold only the inactive ones, newest first, so paging lists each entity once.
   * More active entities than a page holds (over 200) are paged as before, oldest last.
   */
  private entries<C extends EntityCollection>(
    thread: Pick<Thread, "id">,
    collection: C,
    before: number,
    limit: number,
    maxBytes: number,
  ): { entries: StoredEntity<C>[]; entitiesBefore: number | null } {
    const most = Math.min(limit, 200);
    const newestPage = before >= Number.MAX_SAFE_INTEGER;
    // Every page decides alike whether actives go first, so the pages after the newest agree.
    const activeCount = Number(
      this.sql(
        "SELECT count(*) AS n FROM (SELECT 1 FROM view_entity_windows WHERE thread_id=? AND collection=? AND active=1 LIMIT 201)",
      ).get(thread.id, collection)?.n ?? 0,
    );
    const activeFirst = activeCount <= 200;
    const actives =
      activeFirst && newestPage
        ? [...this.rows(thread.id, collection, "w.active=1", "DESC LIMIT 201")]
        : [];
    const rows = actives;
    let bytes = rows.reduce((total, row) => total + Buffer.byteLength(String(row.value)), 0);
    let oldest = before;
    let more = false;
    // Inactive ones newest first while there is room; with no active-first page, every entity.
    const room = Math.max(0, most - rows.length);
    const rest = this.rows(
      thread.id,
      collection,
      activeFirst ? "w.created_seq<? AND w.active=0" : "w.created_seq<?",
      "DESC LIMIT ?",
      before,
      room + 1,
    );
    let taken = 0;
    for (const row of rest) {
      const size = Buffer.byteLength(String(row.value));
      if (taken >= room || (rows.length && bytes + size > maxBytes)) {
        more = true;
        break;
      }
      rows.push(row);
      bytes += size;
      taken++;
      oldest = Number(row.created_seq);
    }
    // A newest page whose actives left no room for an inactive one: those begin just below
    // the end of time, so the next page is not the newest again.
    if (activeFirst && newestPage && taken === 0) {
      if (room === 0)
        more = !this.rows(thread.id, collection, "w.active=0", "DESC LIMIT 1").next().done;
      oldest = Number.MAX_SAFE_INTEGER - 1;
    }
    const entries = rows
      .toSorted((a, b) => Number(a.created_seq) - Number(b.created_seq))
      .map((row) => storedEntity(collection, String(row.value), this.trust));
    return { entries, entitiesBefore: more ? oldest : null };
  }
}
