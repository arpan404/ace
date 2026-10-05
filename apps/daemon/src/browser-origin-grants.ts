import { z } from "zod";
import { BrowserOrigin, BrowserOriginGrant, ThreadId } from "@ace/protocol";
import type { Store } from "./store.ts";

const Count = z.object({ count: z.number().int().nonnegative() });
/** Indexed grant access and transactional counters, including FK cascades. */
export class BrowserOriginGrants {
  private store: Store;
  private now: () => number;
  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
    store.atomic((db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS browser_origin_grants (
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          origin TEXT NOT NULL, granted_at REAL NOT NULL, PRIMARY KEY(thread_id,origin)
        );
        CREATE TABLE IF NOT EXISTS browser_origin_counts (
          scope TEXT PRIMARY KEY, count INTEGER NOT NULL CHECK(count >= 0)
        );
      `);
      // One migration scan, never a grant-path or restart scan.
      if (!db.prepare("SELECT 1 FROM browser_origin_counts WHERE scope='global'").get()) {
        db.exec(`
          INSERT INTO browser_origin_counts SELECT 'global', count(*) FROM browser_origin_grants;
          INSERT INTO browser_origin_counts SELECT 'thread:' || thread_id, count(*) FROM browser_origin_grants GROUP BY thread_id;
        `);
      }
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS browser_origin_count_insert AFTER INSERT ON browser_origin_grants BEGIN
          UPDATE browser_origin_counts SET count=count+1 WHERE scope='global';
          INSERT INTO browser_origin_counts VALUES ('thread:' || NEW.thread_id,1)
            ON CONFLICT(scope) DO UPDATE SET count=count+1;
        END;
        CREATE TRIGGER IF NOT EXISTS browser_origin_count_delete AFTER DELETE ON browser_origin_grants BEGIN
          UPDATE browser_origin_counts SET count=count-1 WHERE scope='global';
          UPDATE browser_origin_counts SET count=count-1 WHERE scope='thread:' || OLD.thread_id;
          DELETE FROM browser_origin_counts WHERE scope='thread:' || OLD.thread_id AND count=0;
        END;
      `);
    });
  }
  list(threadId: string): BrowserOriginGrant[] {
    return this.store
      .atomic((db) =>
        db
          .prepare(
            "SELECT origin,granted_at AS grantedAt FROM browser_origin_grants WHERE thread_id=? ORDER BY origin",
          )
          .all(ThreadId.parse(threadId)),
      )
      .map((row) => BrowserOriginGrant.parse(row));
  }
  has(threadId: ThreadId, origin: string): boolean {
    return (
      this.store.atomic((db) =>
        db
          .prepare("SELECT 1 FROM browser_origin_grants WHERE thread_id=? AND origin=?")
          .get(threadId, origin),
      ) !== undefined
    );
  }
  grant(threadId: string, raw: string): void {
    const id = ThreadId.parse(threadId),
      origin = BrowserOrigin.parse(raw);
    const thread = this.store.getThread(id);
    if (!thread || thread.deletedAt !== undefined) throw new Error("Browser thread unavailable");
    this.store.atomic((db) => {
      if (this.has(id, origin)) return;
      const count = (scope: string) => {
        const row = db.prepare("SELECT count FROM browser_origin_counts WHERE scope=?").get(scope);
        return row === undefined ? 0 : Count.parse(row).count;
      };
      if (count(`thread:${id}`) >= 256 || count("global") >= 16_384)
        throw new Error("Browser origin grant limit; revoke an origin first");
      db.prepare("INSERT INTO browser_origin_grants VALUES (?,?,?)").run(id, origin, this.now());
    });
  }
  revoke(threadId: string, origin: string): void {
    this.store.atomic((db) =>
      db
        .prepare("DELETE FROM browser_origin_grants WHERE thread_id=? AND origin=?")
        .run(ThreadId.parse(threadId), BrowserOrigin.parse(origin)),
    );
  }
}
