import type { DatabaseSync } from "node:sqlite";

/** The thread_cold table itself: a versioned schema step, so older builds refuse the file. */
export const threadColdTable = `CREATE TABLE IF NOT EXISTS thread_cold (
    thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE ON UPDATE CASCADE,
    details JSON,
    capabilities JSON
  );`;

/**
 * A thread's details and capabilities, about 85% of its stored size, change rarely, so they
 * live in thread_cold and an event rewrites only the narrow threads row. A write to either
 * still gives the thread a new row revision. Rows written before the split are moved here;
 * the pass is idempotent and finds nothing to move after the first start. Needs the client
 * column and sidebar_thread_revisions.
 */
export function migrateThreadCold(db: DatabaseSync): void {
  db.exec(`
    -- Every change to a cold row gives each thread it belonged to, or now belongs to, a new
    -- revision, so no cached copy keeps a value that moved or went. Only threads that still
    -- exist: a cold row removed or moved because its thread was deleted or renamed has no
    -- old owner left to bump. Delete, then insert, as sidebar_thread_update does: the
    -- writing statement's conflict rule would replace a trigger's OR REPLACE. Recreated on
    -- every start, so older bodies are replaced.
    SAVEPOINT thread_cold_triggers;
    DROP TRIGGER IF EXISTS thread_cold_insert;
    DROP TRIGGER IF EXISTS thread_cold_update;
    DROP TRIGGER IF EXISTS thread_cold_delete;
    CREATE TRIGGER thread_cold_insert AFTER INSERT ON thread_cold BEGIN
      DELETE FROM sidebar_thread_revisions WHERE thread_id = NEW.thread_id;
      INSERT INTO sidebar_thread_revisions(thread_id)
        SELECT id FROM threads WHERE id = NEW.thread_id;
    END;
    CREATE TRIGGER thread_cold_update AFTER UPDATE ON thread_cold BEGIN
      DELETE FROM sidebar_thread_revisions WHERE thread_id IN (OLD.thread_id, NEW.thread_id)
        AND thread_id IN (SELECT id FROM threads);
      INSERT INTO sidebar_thread_revisions(thread_id)
        SELECT id FROM threads WHERE id IN (OLD.thread_id, NEW.thread_id);
    END;
    CREATE TRIGGER thread_cold_delete AFTER DELETE ON thread_cold BEGIN
      DELETE FROM sidebar_thread_revisions WHERE thread_id = OLD.thread_id
        AND thread_id IN (SELECT id FROM threads);
      INSERT INTO sidebar_thread_revisions(thread_id)
        SELECT id FROM threads WHERE id = OLD.thread_id;
    END;
    RELEASE thread_cold_triggers;
    -- Foreign keys cascade these; the triggers cover a connection with them off.
    CREATE TRIGGER IF NOT EXISTS thread_cold_owner_delete AFTER DELETE ON threads BEGIN
      DELETE FROM thread_cold WHERE thread_id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS thread_cold_owner_rekey AFTER UPDATE OF id ON threads
    WHEN OLD.id IS NOT NEW.id BEGIN
      UPDATE thread_cold SET thread_id = NEW.id WHERE thread_id = OLD.id;
    END;
    INSERT INTO thread_cold(thread_id, details, capabilities)
      SELECT id, client -> '$.details', provider_metadata -> '$.capabilities' FROM threads
      WHERE json_type(client, '$.details') IS NOT NULL
        OR json_type(provider_metadata, '$.capabilities') IS NOT NULL
      ON CONFLICT(thread_id) DO UPDATE SET
        details = COALESCE(excluded.details, details),
        capabilities = COALESCE(excluded.capabilities, capabilities);
    UPDATE threads SET
      client = json_remove(client, '$.details'),
      provider_metadata = json_remove(provider_metadata, '$.capabilities')
      WHERE json_type(client, '$.details') IS NOT NULL
        OR json_type(provider_metadata, '$.capabilities') IS NOT NULL;
  `);
}
