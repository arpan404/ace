// SPDX-License-Identifier: Apache-2.0
// Generated from apps/daemon/src/migrations.ts by scripts/generate-rust-schema.ts.
// Do not edit: run `bun scripts/generate-rust-schema.ts`.

/// The oldest schema an existing database is upgraded from (`migrations.ts`'s `UPGRADE_FLOOR`).
pub const UPGRADE_FLOOR: i64 = 14;

/// Every step, in order; a database at version N has run steps 1 to N.
pub const MIGRATIONS: &[&str] = &[
    // 1
    r#"CREATE TABLE events (
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
  );"#,
    // 2
    r#"CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes JSON NOT NULL,
    created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, revoked_at INTEGER
  );"#,
    // 3
    r#"CREATE TABLE items (
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
  CREATE TABLE payload_migration (id INTEGER PRIMARY KEY);"#,
    // 4
    r#"CREATE TABLE item_heads (
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
  CREATE TABLE status_migration (id INTEGER PRIMARY KEY);"#,
    // 5
    r#"ALTER TABLE item_heads ADD COLUMN text_last_unit INTEGER NOT NULL DEFAULT -1;
  UPDATE item_text_chunks SET append = COALESCE(
    (SELECT payload -> '$.append' FROM events WHERE seq = item_text_chunks.seq AND type = 'item.delta'),
    json_quote(append)
  );
  CREATE TABLE text_encoding_migration (id INTEGER PRIMARY KEY);"#,
    // 6
    r#"CREATE TABLE item_previews (
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
  CREATE TABLE item_preview_migration (id INTEGER PRIMARY KEY);"#,
    // 7
    r#"ALTER TABLE threads ADD COLUMN imported JSON;
   CREATE UNIQUE INDEX imported_source ON threads(json_extract(imported,'$.sourceId')) WHERE imported IS NOT NULL;
   CREATE TABLE history_blobs(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,size INTEGER NOT NULL);
   CREATE TABLE history_blob_chunks(blob_id TEXT NOT NULL REFERENCES history_blobs(id) ON DELETE CASCADE,offset INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(blob_id,offset));"#,
    // 8
    r#"CREATE TABLE usage_deletions (seq INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, at INTEGER NOT NULL);"#,
    // 9
    r#"ALTER TABLE threads ADD COLUMN acp JSON;"#,
    // 10
    r#"ALTER TABLE threads ADD COLUMN transitions JSON;
   ALTER TABLE threads ADD COLUMN provider_metadata JSON;"#,
    // 11
    r#"ALTER TABLE item_text_streams RENAME TO item_text_streams_old;
   CREATE TABLE item_text_streams (
     id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
     item_id TEXT NOT NULL, part INTEGER NOT NULL, size INTEGER NOT NULL
   );
   INSERT INTO item_text_streams SELECT * FROM item_text_streams_old;
   CREATE TABLE item_source_chunks_next (
     stream_id TEXT NOT NULL REFERENCES item_text_streams(id) ON DELETE CASCADE,
     offset INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(stream_id, offset)
   );
   INSERT INTO item_source_chunks_next SELECT * FROM item_source_chunks;
   DROP TABLE item_source_chunks;
   DROP TABLE item_text_streams_old;
   ALTER TABLE item_source_chunks_next RENAME TO item_source_chunks;
   CREATE INDEX item_text_streams_item ON item_text_streams(item_id, part);
   CREATE TABLE item_text_targets (
     item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
     stream_id TEXT NOT NULL REFERENCES item_text_streams(id) ON DELETE CASCADE
   );
   INSERT INTO item_text_targets SELECT p.id, s.id FROM item_previews p JOIN item_text_streams s
     ON s.id=CASE WHEN json_extract(p.item,'$.type')='message'
       THEN json_extract(p.item,'$.parts[' || p.target || '].source.streamId')
       ELSE json_extract(p.item,'$.source.streamId') END;"#,
    // 12
    r#"CREATE TABLE IF NOT EXISTS streamed_blobs(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,size INTEGER NOT NULL,sha256 TEXT,storage_id TEXT NOT NULL,chunks INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS streamed_blob_chunks(blob_id TEXT NOT NULL REFERENCES streamed_blobs(id) ON DELETE CASCADE,offset INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(blob_id,offset));
   CREATE INDEX IF NOT EXISTS streamed_blob_hash ON streamed_blobs(thread_id,sha256);"#,
    // 13
    r#"CREATE INDEX IF NOT EXISTS engine_live_threads ON threads(id)
    WHERE json_extract(status,'$.state') NOT IN ('new','done','failed');"#,
    // 14
    r#"CREATE TABLE IF NOT EXISTS upgrade_cleanup (id TEXT PRIMARY KEY);"#,
    // 15
    r#"ALTER TABLE item_heads ADD COLUMN agent_id TEXT NOT NULL DEFAULT '';
  UPDATE item_heads SET agent_id = COALESCE(
    (SELECT json_extract(item, '$.agentId') FROM items WHERE items.id = item_heads.id), '');
  CREATE INDEX item_heads_thread_agent ON item_heads(thread_id, agent_id, created_seq);"#,
    // 16
    r#"ALTER TABLE devices ADD COLUMN expires_at INTEGER;"#,
    // 17
    r#"CREATE TABLE IF NOT EXISTS thread_cold (
    thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE ON UPDATE CASCADE,
    details JSON,
    capabilities JSON
  );"#,
    // 18
    r#"CREATE TABLE IF NOT EXISTS skill_usage (
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL,
    name TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY(item_id, name)
  );
  CREATE INDEX IF NOT EXISTS skill_usage_name_at ON skill_usage(name, at);
  INSERT OR IGNORE INTO skill_usage
    SELECT items.id, items.thread_id, json_extract(part.value, '$.name'),
      COALESCE(json_extract(items.item, '$.createdAt'), 0)
    FROM items, json_each(items.item, '$.parts') AS part
    WHERE json_extract(items.item, '$.type') = 'message'
      AND json_extract(items.item, '$.role') = 'user'
      AND COALESCE(json_extract(items.item, '$.synthetic'), 0) = 0
      AND json_extract(items.item, '$.inherited') IS NULL
      AND json_extract(part.value, '$.type') = 'mention'
      AND json_extract(part.value, '$.kind') = 'skill'
      AND typeof(json_extract(part.value, '$.name')) = 'text';"#,
    // 19
    r#"CREATE TABLE IF NOT EXISTS machine_children (
  id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, parent_thread TEXT NOT NULL,
  parent_agent TEXT NOT NULL, machine TEXT NOT NULL, role TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL, view TEXT,
  settled INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0);
  ALTER TABLE machine_children ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE machine_children ADD COLUMN settled_at INTEGER;
  ALTER TABLE machine_children ADD COLUMN rechecked INTEGER NOT NULL DEFAULT 0;
  UPDATE machine_children SET settled_at = created_at WHERE settled = 1;
  CREATE INDEX IF NOT EXISTS machine_children_settled ON machine_children(settled, settled_at);
  CREATE INDEX IF NOT EXISTS machine_children_recheck
    ON machine_children(settled, machine, rechecked);
  CREATE TABLE IF NOT EXISTS machine_child_messages (
    child_id TEXT NOT NULL, request_id TEXT NOT NULL, message TEXT NOT NULL,
    created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (child_id, request_id));
  CREATE INDEX IF NOT EXISTS machine_child_messages_due
    ON machine_child_messages(next_retry_at, created_at);"#,
    // 20
    r#"CREATE TABLE IF NOT EXISTS machine_threads (
  thread_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, kind TEXT NOT NULL,
  origin_host TEXT NOT NULL, origin_thread TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS machine_child_launches (
    thread_id TEXT PRIMARY KEY, parent TEXT NOT NULL, role TEXT NOT NULL, outcome TEXT,
    active INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS machine_child_launches_active
    ON machine_child_launches(parent, active);
  INSERT OR IGNORE INTO machine_child_launches (thread_id, parent, role, outcome, active)
    SELECT m.thread_id, json_array(m.device_id, m.origin_host, m.origin_thread), '', NULL,
      CASE WHEN json_extract(t.status, '$.state') IN ('new', 'done', 'failed') THEN 0 ELSE 1 END
    FROM machine_threads m JOIN threads t ON t.id = m.thread_id
    WHERE m.kind = 'delegate';"#,
    // 21
    r#"
  ALTER TABLE machine_children ADD COLUMN device_id TEXT;
  ALTER TABLE machine_children ADD COLUMN lost_at INTEGER;
  ALTER TABLE machine_children ADD COLUMN lost_key TEXT;
  ALTER TABLE machine_children ADD COLUMN lost_ask TEXT;
  CREATE INDEX IF NOT EXISTS machine_children_lost ON machine_children(lost_ask)
    WHERE lost_ask IS NOT NULL;
  CREATE INDEX IF NOT EXISTS machine_children_parent ON machine_children(parent_thread, settled);
  CREATE INDEX IF NOT EXISTS machine_children_undelivered ON machine_children(settled_at)
    WHERE settled = 1 AND delivered = 0;
  CREATE TABLE IF NOT EXISTS machine_child_cursors (
    machine TEXT PRIMARY KEY, served INTEGER NOT NULL DEFAULT 0, after TEXT);
  CREATE INDEX IF NOT EXISTS machine_child_cursors_served
    ON machine_child_cursors(served, machine);
  CREATE INDEX IF NOT EXISTS machine_children_unsettled ON machine_children(machine, id)
    WHERE settled = 0;
  INSERT OR IGNORE INTO machine_child_cursors (machine)
    SELECT DISTINCT machine FROM machine_children WHERE settled = 0;
  CREATE TABLE IF NOT EXISTS machine_message_rejections (
    request_key TEXT PRIMARY KEY, device_id TEXT NOT NULL, code TEXT NOT NULL,
    message TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS machine_message_rejections_device
    ON machine_message_rejections(device_id);
  CREATE TRIGGER IF NOT EXISTS machine_message_rejections_revoked
    AFTER UPDATE OF revoked_at ON devices WHEN NEW.revoked_at IS NOT NULL
    BEGIN DELETE FROM machine_message_rejections WHERE device_id = NEW.id; END;"#,
    // 22
    r#"CREATE TABLE IF NOT EXISTS machine_grants (
  device_id TEXT NOT NULL, capability TEXT NOT NULL, level TEXT NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY (device_id, capability));
  CREATE TRIGGER IF NOT EXISTS machine_grants_revoked
    AFTER UPDATE OF revoked_at ON devices WHEN NEW.revoked_at IS NOT NULL
    BEGIN DELETE FROM machine_grants WHERE device_id = NEW.id; END;"#,
    // 23
    r#"CREATE TABLE IF NOT EXISTS machine_jobs (
  machine TEXT NOT NULL, job_id TEXT NOT NULL, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  deadline INTEGER NOT NULL, stopping INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  PRIMARY KEY (machine, job_id));"#,
    // 24
    r#"CREATE TABLE IF NOT EXISTS agent_conversations (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
      owner_thread TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      owner_agent TEXT NOT NULL, root_id TEXT NOT NULL, request_id TEXT NOT NULL, record TEXT NOT NULL,
      UNIQUE(owner_thread,request_id)
    ); CREATE INDEX IF NOT EXISTS agent_conversations_owner ON agent_conversations(owner_thread,thread_id);
    CREATE INDEX IF NOT EXISTS agent_conversations_root ON agent_conversations(root_id,thread_id);
  UPDATE threads SET transitions = json_set(COALESCE(transitions, '{}'), '$.startedBy',
      (SELECT owner_thread FROM agent_conversations c WHERE c.thread_id = threads.id))
    WHERE id IN (SELECT thread_id FROM agent_conversations)
      AND json_extract(transitions, '$.startedBy') IS NULL;"#,
    // 25
    r#"
  CREATE TABLE IF NOT EXISTS offshift_runs (
    thread_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(thread_id,id)
  );
  UPDATE threads SET status='{"state":"done"}'
    WHERE id IN (SELECT thread_id FROM offshift_runs)
      AND json_extract(status,'$.state')='working'
      AND NOT EXISTS (SELECT 1 FROM view_entities v WHERE v.thread_id=threads.id
        AND ((v.collection='agents' AND json_extract(v.value,'$.status.state')
          IN ('starting','working','blocked','unresponsive'))
          OR (v.collection='backgroundTasks' AND json_extract(v.value,'$.status')='running')
          OR (v.collection='queue' AND json_extract(v.value,'$.pendingCount')>0)
          OR (v.collection='interactions' AND json_extract(v.value,'$.state')='pending')));
  UPDATE threads SET provider_metadata=json_remove(provider_metadata,'$.run')
    WHERE json_type(provider_metadata,'$.run') IS NOT NULL;
  DELETE FROM view_entities WHERE collection='offshift';
  DROP TABLE IF EXISTS offshift_receipts;
  DROP TABLE offshift_runs;
"#,
    // 26
    r#"
  ALTER TABLE machine_children ADD COLUMN seen_at INTEGER;
  ALTER TABLE machine_children ADD COLUMN silent_since INTEGER;
  ALTER TABLE machine_children ADD COLUMN stop_started_at INTEGER;
  ALTER TABLE machine_children ADD COLUMN stop_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE machine_children ADD COLUMN stop_last_at INTEGER;
  ALTER TABLE machine_children ADD COLUMN stopped_unconfirmed INTEGER NOT NULL DEFAULT 0;
  UPDATE machine_children SET seen_at = COALESCE(settled_at, created_at);
  CREATE INDEX IF NOT EXISTS machine_children_seen ON machine_children(seen_at)
    WHERE settled = 0;
  CREATE INDEX IF NOT EXISTS machine_children_stopping ON machine_children(stop_started_at)
    WHERE settled = 0 AND stop_started_at IS NOT NULL;"#,
    // 27
    r#"
  CREATE TABLE IF NOT EXISTS machine_code (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    hash TEXT,
    version INTEGER NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER
  );
  CREATE TABLE IF NOT EXISTS machine_code_passes (
    device_id TEXT NOT NULL,
    account TEXT NOT NULL,
    version INTEGER NOT NULL,
    passed_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, account)
  );"#,
    // 28
    r#"ALTER TABLE devices ADD COLUMN install_id TEXT;
  ALTER TABLE devices ADD COLUMN merged_into TEXT;
  CREATE INDEX devices_install ON devices(install_id) WHERE install_id IS NOT NULL;"#,
    // 29
    r#"ALTER TABLE devices ADD COLUMN account_link TEXT;"#,
    // 30
    r#"
  CREATE TABLE IF NOT EXISTS outside_grants (
    id TEXT PRIMARY KEY,
    client_kind TEXT NOT NULL,
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    domain TEXT,
    scopes TEXT NOT NULL,
    projects TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    last_used_at INTEGER,
    revoked_at INTEGER,
    approved_by TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS outside_grant_tokens (
    hash TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES outside_grants(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    expires_at INTEGER,
    rotated_at INTEGER,
    pair TEXT,
    successor TEXT
  );
  CREATE INDEX IF NOT EXISTS outside_grant_tokens_grant ON outside_grant_tokens(grant_id);
  CREATE INDEX IF NOT EXISTS outside_grant_tokens_pair ON outside_grant_tokens(pair);
  CREATE TABLE IF NOT EXISTS outside_grant_threads (
    grant_id TEXT NOT NULL REFERENCES outside_grants(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (grant_id, thread_id, kind)
  );"#,
    // 31
    r#"
  ALTER TABLE outside_grant_tokens ADD COLUMN resource TEXT;
  CREATE TABLE IF NOT EXISTS outside_oauth_clients (
    client_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used_at INTEGER
  );"#,
    // 32
    r#"CREATE TABLE IF NOT EXISTS spade_computer_drivers (bot TEXT PRIMARY KEY, takeover TEXT NOT NULL);"#,
    // 33
    r#"ALTER TABLE item_heads ADD COLUMN raw_seq INTEGER NOT NULL DEFAULT 0;"#,
    // 34
    r#"ALTER TABLE devices ADD COLUMN person INTEGER;"#,
    // 35
    r#"ALTER TABLE devices ADD COLUMN standing_key TEXT;"#,
];

/// The threads columns `migrations.ts` requires after every step has run, comma-separated.
/// (One line, so `cargo fmt` and this generator agree on the file's shape.)
pub const THREAD_METADATA_COLUMNS: &str = r#"acp,transitions,provider_metadata"#;
