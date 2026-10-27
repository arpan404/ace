import type { DatabaseSync } from "node:sqlite";
/**
 * Row revisions cover direct SQL and other writers, not just published domain events.
 * Every insert or update of a threads row takes a fresh, never-reused revision; a delete
 * drops the row's revision, counts the delete and logs the id it removed (the newest
 * `sidebarRemovalLog` of them), with or without foreign keys on.
 */
/** Removed ids kept for the live sidebar; a reader further behind rebuilds instead. */
export const sidebarRemovalLog = 4096;

export function migrateSidebarRevisions(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sidebar_thread_revisions (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS sidebar_thread_deletes (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      count INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO sidebar_thread_deletes(id, count) VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS sidebar_thread_removals (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL
    );
    -- Delete, then insert. A statement's own conflict rule (an upsert, OR IGNORE, OR
    -- ROLLBACK) replaces the rule of every statement its triggers run, so an OR REPLACE
    -- here could fail or be skipped. Recreated on every start, so older bodies are replaced.
    SAVEPOINT sidebar_revision_triggers;
    DROP TRIGGER IF EXISTS sidebar_thread_insert;
    DROP TRIGGER IF EXISTS sidebar_thread_update;
    DROP TRIGGER IF EXISTS sidebar_thread_rekey;
    DROP TRIGGER IF EXISTS sidebar_thread_delete;
    CREATE TRIGGER sidebar_thread_insert AFTER INSERT ON threads BEGIN
      DELETE FROM sidebar_thread_revisions WHERE thread_id = NEW.id;
      INSERT INTO sidebar_thread_revisions(thread_id) VALUES (NEW.id);
    END;
    CREATE TRIGGER sidebar_thread_update AFTER UPDATE ON threads BEGIN
      DELETE FROM sidebar_thread_revisions WHERE thread_id = NEW.id;
      INSERT INTO sidebar_thread_revisions(thread_id) VALUES (NEW.id);
    END;
    -- A changed id is a delete of the old one (only possible with foreign keys off).
    CREATE TRIGGER sidebar_thread_rekey AFTER UPDATE OF id ON threads
    WHEN OLD.id IS NOT NEW.id BEGIN
      DELETE FROM sidebar_thread_revisions WHERE thread_id = OLD.id;
      UPDATE sidebar_thread_deletes SET count = count + 1 WHERE id = 1;
      INSERT INTO sidebar_thread_removals(thread_id) VALUES (OLD.id);
      DELETE FROM sidebar_thread_removals
        WHERE revision <= (SELECT MAX(revision) FROM sidebar_thread_removals) - ${sidebarRemovalLog};
    END;
    CREATE TRIGGER sidebar_thread_delete AFTER DELETE ON threads BEGIN
      DELETE FROM sidebar_thread_revisions WHERE thread_id = OLD.id;
      UPDATE sidebar_thread_deletes SET count = count + 1 WHERE id = 1;
      INSERT INTO sidebar_thread_removals(thread_id) VALUES (OLD.id);
      DELETE FROM sidebar_thread_removals
        WHERE revision <= (SELECT MAX(revision) FROM sidebar_thread_removals) - ${sidebarRemovalLog};
    END;
    RELEASE sidebar_revision_triggers;
    -- Rows deleted while foreign keys were off, before the delete trigger existed.
    DELETE FROM sidebar_thread_revisions WHERE thread_id NOT IN (SELECT id FROM threads);
    -- Rows written before the triggers existed get a revision, so every row has one.
    INSERT OR IGNORE INTO sidebar_thread_revisions(thread_id) SELECT id FROM threads;
  `);
}
