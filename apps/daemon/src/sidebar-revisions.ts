import type { DatabaseSync } from "node:sqlite";
/** Row revisions cover direct SQL and other writers, not just published domain events. */
export function migrateSidebarRevisions(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sidebar_thread_revisions (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE
    );
    CREATE TRIGGER IF NOT EXISTS sidebar_thread_insert AFTER INSERT ON threads BEGIN
      INSERT OR REPLACE INTO sidebar_thread_revisions(thread_id) VALUES (NEW.id);
    END;
    CREATE TRIGGER IF NOT EXISTS sidebar_thread_update AFTER UPDATE ON threads BEGIN
      INSERT OR REPLACE INTO sidebar_thread_revisions(thread_id) VALUES (NEW.id);
    END;
  `);
}
