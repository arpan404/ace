import type { DatabaseSync } from "node:sqlite";

/** Separate engine versioning avoids colliding with concurrent store migrations. */
export function migrateEngine(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS engine_schema_version (
    id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL
  )`);
  const version = Number(
    db.prepare("SELECT version FROM engine_schema_version").get()?.version ?? 0,
  );
  if (version > 6) throw new Error("Engine schema is newer than this daemon");
  if (version === 6) return;
  if (version === 0) {
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
  if (version < 2)
    db.exec(`ALTER TABLE intents ADD COLUMN awaiting INTEGER NOT NULL DEFAULT 0;
    UPDATE engine_schema_version SET version=2 WHERE id=1;`);
  if (version < 3)
    db.exec(`CREATE TABLE engine_state_records (
    thread_id TEXT NOT NULL REFERENCES thread_state(thread_id), section TEXT NOT NULL, key TEXT NOT NULL, value JSON NOT NULL,
    PRIMARY KEY(thread_id, section, key)
  );
  UPDATE engine_schema_version SET version=3 WHERE id=1;`);
  if (version < 4)
    db.exec(`CREATE TABLE engine_slots (thread_id TEXT PRIMARY KEY);
    CREATE TABLE engine_raw_blobs (id TEXT PRIMARY KEY, bytes BLOB NOT NULL);
    UPDATE engine_schema_version SET version=4 WHERE id=1;`);
  if (version < 5)
    db.exec(`CREATE TABLE engine_state_appends (
    id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
    section TEXT NOT NULL, key TEXT NOT NULL, patch JSON NOT NULL
  );
  CREATE INDEX engine_state_appends_by_key ON engine_state_appends(thread_id,section,key,id);
  UPDATE engine_schema_version SET version=5 WHERE id=1;`);
  db.exec(`CREATE INDEX intents_waiting_ack ON intents(thread_id,id) WHERE awaiting=1;
    CREATE INDEX intents_outstanding ON intents(status,id) WHERE status IN ('pending','queued','running');
    UPDATE engine_schema_version SET version=6 WHERE id=1;`);
}
