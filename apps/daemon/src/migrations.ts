import type { DatabaseSync } from "node:sqlite";

const migrations = [
  `CREATE TABLE events (
    seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL,
    at INTEGER NOT NULL, type TEXT NOT NULL, payload JSON NOT NULL
  );
  CREATE INDEX events_thread_seq ON events(thread_id, seq);
  CREATE TABLE command_receipts (
    command_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, received_at INTEGER NOT NULL, result JSON NOT NULL
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE threads (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), title TEXT NOT NULL,
    provider TEXT NOT NULL, status JSON NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    archived_at INTEGER, root_agent_id TEXT
  );`,
  `CREATE TABLE items (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    created_seq INTEGER NOT NULL UNIQUE, item JSON NOT NULL
  );
  CREATE INDEX items_thread_creation ON items(thread_id, created_seq);
  CREATE TABLE output_streams (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL UNIQUE, size INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE output_chunks (
    stream_id TEXT NOT NULL REFERENCES output_streams(id) ON DELETE CASCADE,
    offset INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(stream_id, offset)
  );
  CREATE TABLE blobs (
    id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, bytes BLOB NOT NULL,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    UNIQUE(thread_id, sha256)
  );
  CREATE TABLE host_sequence (id INTEGER PRIMARY KEY CHECK(id = 1), seq INTEGER NOT NULL);
  INSERT INTO host_sequence SELECT 1, COALESCE(MAX(seq), 0) FROM events;
  CREATE TABLE payload_migration (id INTEGER PRIMARY KEY);`,
];
export function migrate(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)",
    );
    const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get();
    const version = Number(row?.version ?? 0);
    if (version > migrations.length) throw new Error("Database schema is newer than this daemon");
    for (let i = version; i < migrations.length; i++) {
      const sql = migrations[i];
      if (sql === undefined) throw new Error("Missing migration");
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_version VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version",
      ).run(i + 1);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
