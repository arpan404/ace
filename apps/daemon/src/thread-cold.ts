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
    -- Delete, then insert: an upsert's ON CONFLICT would override a trigger's OR REPLACE.
    CREATE TRIGGER IF NOT EXISTS thread_cold_insert AFTER INSERT ON thread_cold BEGIN
      DELETE FROM sidebar_thread_revisions WHERE thread_id = NEW.thread_id;
      INSERT INTO sidebar_thread_revisions(thread_id) VALUES (NEW.thread_id);
    END;
    CREATE TRIGGER IF NOT EXISTS thread_cold_update AFTER UPDATE ON thread_cold BEGIN
      DELETE FROM sidebar_thread_revisions WHERE thread_id = NEW.thread_id;
      INSERT INTO sidebar_thread_revisions(thread_id) VALUES (NEW.thread_id);
    END;
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
