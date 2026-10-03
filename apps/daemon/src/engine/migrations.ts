import type { DatabaseSync } from "node:sqlite";
import { engineSchemaVersion, requireEngineVersion } from "./schema-version.ts";

/** Initializes a fresh engine schema; incompatible unreleased development formats fail loudly. */
export function migrateEngine(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS engine_schema_version (
    id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL
  )`);
  const row = db.prepare("SELECT version FROM engine_schema_version WHERE id=1").get();
  if (row) {
    requireEngineVersion(row);
    const columns = db.prepare("PRAGMA table_info(engine_sessions)").all();
    if (!columns.some((column) => column.name === "instance_id"))
      db.exec("ALTER TABLE engine_sessions ADD COLUMN instance_id TEXT");
    if (!columns.some((column) => column.name === "options"))
      db.exec("ALTER TABLE engine_sessions ADD COLUMN options JSON");
    return;
  }
  const legacy = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (
    'thread_state', 'engine_sessions', 'intents', 'engine_state_records',
    'engine_state_appends', 'engine_slots', 'engine_raw_blobs'
  ) LIMIT 1`)
    .get();
  if (legacy) requireEngineVersion(undefined);

  db.exec(`CREATE TABLE thread_state (
    thread_id TEXT PRIMARY KEY REFERENCES threads(id), state JSON NOT NULL, seq INTEGER NOT NULL
  );
  CREATE TABLE engine_sessions (
    thread_id TEXT PRIMARY KEY REFERENCES threads(id), cwd TEXT NOT NULL,
    model TEXT, native_session_id TEXT, instance_id TEXT, options JSON
  );
  CREATE TABLE intents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL REFERENCES threads(id), kind TEXT NOT NULL, payload JSON NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'queued', 'running', 'done', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0, error TEXT, resolution_id TEXT UNIQUE,
    awaiting INTEGER NOT NULL DEFAULT 0, ack_target INTEGER
  );
  CREATE INDEX intents_pending ON intents(thread_id, status, id);
  CREATE INDEX intents_waiting_ack ON intents(thread_id,id) WHERE awaiting=1;
  CREATE INDEX intents_outstanding ON intents(status,id) WHERE status IN ('pending','queued','running');
  CREATE TABLE engine_state_records (
    thread_id TEXT NOT NULL REFERENCES thread_state(thread_id), section TEXT NOT NULL, key TEXT NOT NULL, value JSON NOT NULL,
    PRIMARY KEY(thread_id, section, key)
  );
  CREATE TABLE engine_slots (thread_id TEXT PRIMARY KEY);
  CREATE TABLE engine_raw_blobs (id TEXT PRIMARY KEY, bytes BLOB NOT NULL);
  CREATE TABLE engine_state_appends (
    id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
    section TEXT NOT NULL, key TEXT NOT NULL, patch JSON NOT NULL
  );
  CREATE INDEX engine_state_appends_by_key ON engine_state_appends(thread_id,section,key,id);`);
  db.prepare("INSERT INTO engine_schema_version VALUES (1, ?)").run(engineSchemaVersion);
}
