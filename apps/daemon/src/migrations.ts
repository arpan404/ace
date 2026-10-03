import { z } from "zod";
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
  `CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes JSON NOT NULL,
    created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, revoked_at INTEGER
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
  `CREATE TABLE item_heads (
    id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL, created_seq INTEGER NOT NULL UNIQUE,
    size INTEGER NOT NULL, item_type TEXT NOT NULL, text_prefix INTEGER NOT NULL
  );
  CREATE INDEX item_heads_thread_creation ON item_heads(thread_id, created_seq);
  INSERT INTO item_heads SELECT id, thread_id, created_seq, length(CAST(item AS BLOB)), json_extract(item, '$.type'),
    CASE WHEN json_extract(item, '$.type') = 'message'
      AND COALESCE(json_extract(item, '$.parts[#-1].type'), '') != 'text'
      THEN length('{"type":"text","text":""}') + CASE WHEN json_array_length(item, '$.parts') > 0 THEN 1 ELSE 0 END ELSE 0 END FROM items;
  CREATE TABLE item_text_chunks (
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, field TEXT NOT NULL, append TEXT NOT NULL, PRIMARY KEY(item_id, seq)
  );
  CREATE TABLE view_entities (
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    collection TEXT NOT NULL, id TEXT NOT NULL, value JSON NOT NULL,
    PRIMARY KEY(thread_id, collection, id)
  );
  CREATE TABLE status_migration (id INTEGER PRIMARY KEY);`,
  `ALTER TABLE item_heads ADD COLUMN text_last_unit INTEGER NOT NULL DEFAULT -1;
  UPDATE item_text_chunks SET append = COALESCE(
    (SELECT payload -> '$.append' FROM events WHERE seq = item_text_chunks.seq AND type = 'item.delta'),
    json_quote(append)
  );
  CREATE TABLE text_encoding_migration (id INTEGER PRIMARY KEY);`,
  `CREATE TABLE item_previews (
    id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE, item JSON NOT NULL, target INTEGER NOT NULL
  );
  CREATE TABLE item_text_streams (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, part INTEGER NOT NULL, size INTEGER NOT NULL,
    UNIQUE(item_id, part)
  );
  CREATE TABLE item_source_chunks (
    stream_id TEXT NOT NULL REFERENCES item_text_streams(id) ON DELETE CASCADE,
    offset INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(stream_id, offset)
  );
  CREATE TABLE item_preview_migration (id INTEGER PRIMARY KEY);`,
  `ALTER TABLE threads ADD COLUMN imported JSON;
   CREATE UNIQUE INDEX imported_source ON threads(json_extract(imported,'$.sourceId')) WHERE imported IS NOT NULL;
   CREATE TABLE history_blobs(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,size INTEGER NOT NULL);
   CREATE TABLE history_blob_chunks(blob_id TEXT NOT NULL REFERENCES history_blobs(id) ON DELETE CASCADE,offset INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(blob_id,offset));`,
  `CREATE TABLE usage_deletions (seq INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, at INTEGER NOT NULL);`,
  `ALTER TABLE threads ADD COLUMN acp JSON;`,
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
    // SDK and ACP branches independently appended the same numbered migration.
    // Upgrade either historical shape by columns, without rewriting its metadata.
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(threads)")
        .all()
        .map((value) => z.object({ name: z.string() }).parse(value).name),
    );
    if (!columns.has("acp")) db.exec("ALTER TABLE threads ADD COLUMN acp JSON");
    if (!columns.has("provider_metadata"))
      db.exec("ALTER TABLE threads ADD COLUMN provider_metadata JSON");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
