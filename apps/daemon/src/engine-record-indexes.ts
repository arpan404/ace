import type { DatabaseSync } from "node:sqlite";

/**
 * Partial indexes over the slivers of `engine_state_records` that engine startup enumerates:
 * interaction records (the request ledger's backfill) and agent records (transition readiness).
 * Without them each startup query reads the whole table. The first build on a large existing
 * database is itself a full read of that table, so the store builds them when it opens, outside
 * the engine's startup deadline; the engine builds them again (a no-op by then, or instant on a
 * table it has just created). Queries stay correct without them, only slower.
 */
export function indexEngineRecords(db: DatabaseSync): void {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='engine_state_records'")
      .get()
  )
    return;
  db.exec(`
    CREATE INDEX IF NOT EXISTS engine_interaction_records ON engine_state_records(section,thread_id)
      WHERE section IN ('interactions','interactionHistory');
    CREATE INDEX IF NOT EXISTS engine_agent_records ON engine_state_records(thread_id)
      WHERE section='agents';
  `);
}
