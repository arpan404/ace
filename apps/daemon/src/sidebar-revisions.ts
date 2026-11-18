import type { DatabaseSync } from "node:sqlite";
/**
 * Row revisions cover direct SQL and other writers, not just published domain events.
 * Every insert or update of a threads row takes a fresh, never-reused revision; a delete
 * drops the row's revision, counts the delete and logs the id it removed (the newest
 * `sidebarRemovalLog` of them), with or without foreign keys on.
 *
 * Every threads row has exactly one revision row: the triggers keep that true for every
 * connection, and builds without them can't open this schema. Threads written before the
 * triggers existed get theirs, and stale rows go, in one pass the first time a home opens
 * with this code; a marker records that it ran, so later opens never read every thread
 * (ADR 0170). That pass is not deferred: the sidebar's facts, its change feed and the thread
 * cache all key on a thread's revision, so a thread without one would drop out of them.
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
    -- Names this database in sidebar resume tokens, so another database's revisions never match.
    CREATE TABLE IF NOT EXISTS sidebar_epoch (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      token TEXT NOT NULL
    );
    INSERT OR IGNORE INTO sidebar_epoch(id, token) VALUES (1, lower(hex(randomblob(8))));
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
    CREATE TABLE IF NOT EXISTS sidebar_revisions_complete (id INTEGER PRIMARY KEY CHECK (id = 1));
  `);
  if (db.prepare("SELECT 1 FROM sidebar_revisions_complete").get()) return;
  // Once per home, with the marker in the same savepoint so a stop part way runs it again.
  db.exec(`
    SAVEPOINT sidebar_revisions_complete;
    -- Rows deleted while foreign keys were off, before the delete trigger existed.
    DELETE FROM sidebar_thread_revisions WHERE thread_id NOT IN (SELECT id FROM threads);
    -- Rows written before the triggers existed get a revision, so every row has one.
    INSERT OR IGNORE INTO sidebar_thread_revisions(thread_id) SELECT id FROM threads;
    INSERT INTO sidebar_revisions_complete VALUES (1);
    RELEASE sidebar_revisions_complete;
  `);
}
