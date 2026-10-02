import type { DatabaseSync } from "node:sqlite";

/** Separate engine versioning avoids colliding with concurrent store migrations. */
export function migrateEngine(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS engine_schema_version (
    id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL
  )`);
  const version = Number(db.prepare("SELECT version FROM engine_schema_version").get()?.version ?? 0);
  if (version > 1) throw new Error("Engine schema is newer than this daemon");
  if (version === 1) return;
  db.exec(`CREATE TABLE thread_state (
    thread_id TEXT PRIMARY KEY REFERENCES threads(id), state JSON NOT NULL, seq INTEGER NOT NULL
  );
  CREATE TABLE engine_sessions (
    thread_id TEXT PRIMARY KEY REFERENCES threads(id), cwd TEXT NOT NULL,
    model TEXT, native_session_id TEXT
  );
  CREATE TABLE intents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL REFERENCES threads(id), kind TEXT NOT NULL, payload JSON NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'queued', 'running', 'done', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0, error TEXT, resolution_id TEXT UNIQUE
  );
  CREATE INDEX intents_pending ON intents(thread_id, status, id);
  INSERT INTO engine_schema_version VALUES (1, 1);`);
}
