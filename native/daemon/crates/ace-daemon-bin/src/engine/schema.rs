// SPDX-License-Identifier: Apache-2.0
//! Engine schema initialization and version check (`apps/daemon/src/engine/migrations.ts`,
//! `schema-version.ts`, and `queue-store.ts`).
//!
//! Creates the engine's tables on a fresh database in one constant-time DDL batch and verifies
//! version 9 plus required columns on an existing database, never running `CREATE INDEX` or
//! history-sized scans on an already-migrated home (ADR 0170).

use std::collections::HashSet;
use std::sync::Arc;

use ace_store::{Connection, Value};

const ENGINE_SCHEMA_VERSION: i64 = 9;

const ENGINE_SESSION_COLUMNS: &[&str] = &["instance_id", "options", "workspace_ready", "backend"];
const INTENT_COLUMNS: &[&str] = &[
    "acknowledged",
    "delivery",
    "trigger",
    "submitted_generation",
    "resolution_generation",
    "position",
    "uncertain",
];
const QUEUE_COLUMNS: &[&str] = &["hold_token", "last_failure", "preferences", "exited"];

const FRESH_ENGINE_DDL: &str = "
CREATE TABLE thread_state (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id), state JSON NOT NULL, seq INTEGER NOT NULL
);
CREATE TABLE engine_sessions (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id), cwd TEXT NOT NULL,
  model TEXT, native_session_id TEXT, instance_id TEXT, options JSON,
  workspace_ready INTEGER NOT NULL DEFAULT 1 CHECK(workspace_ready IN (0,1)), backend TEXT
);
CREATE TABLE intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL REFERENCES threads(id), kind TEXT NOT NULL, payload JSON NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'queued', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT, resolution_id TEXT UNIQUE,
  awaiting INTEGER NOT NULL DEFAULT 0, ack_target INTEGER,
  acknowledged INTEGER NOT NULL DEFAULT 0, delivery TEXT NOT NULL DEFAULT 'queue', trigger TEXT,
  submitted_generation INTEGER, resolution_generation INTEGER,
  position INTEGER NOT NULL DEFAULT 0, uncertain INTEGER NOT NULL DEFAULT 0
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
CREATE INDEX engine_state_appends_by_key ON engine_state_appends(thread_id,section,key,id);
CREATE TABLE engine_provider_cursors (thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, offset INTEGER NOT NULL);
CREATE TABLE engine_provider_frames (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, generation TEXT NOT NULL, seq INTEGER NOT NULL,
  frame JSON NOT NULL, PRIMARY KEY(thread_id,generation,seq)
);
CREATE INDEX engine_provider_frames_thread ON engine_provider_frames(thread_id);
CREATE TABLE engine_queue (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id), revision INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0, reason TEXT, limited INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER, resume_at INTEGER, timer_action TEXT, continuation TEXT, trigger TEXT,
  hold_token INTEGER NOT NULL DEFAULT 0, last_failure TEXT, preferences JSON,
  exited INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE engine_queue_attachments (
  intent_id INTEGER NOT NULL REFERENCES intents(id), thread_id TEXT NOT NULL, hash TEXT NOT NULL,
  PRIMARY KEY(intent_id, hash)
);
CREATE INDEX engine_queue_attachment_lookup ON engine_queue_attachments(thread_id, hash);
CREATE INDEX engine_queue_deadline ON engine_queue(resume_at) WHERE resume_at IS NOT NULL;
CREATE INDEX intents_live_positions ON intents(thread_id,position) WHERE status IN ('pending','queued','running') OR uncertain=1;
CREATE INDEX intents_uncertain ON intents(thread_id) WHERE uncertain=1;
CREATE INDEX intents_queue_messages_recovery ON intents(thread_id,position,id) WHERE ((kind IN ('thread.send','thread.create') AND status IN ('pending','queued')) OR (kind IN ('thread.send','thread.create','thread.resume','queue.resume','thread.limit') AND uncertain=1));
CREATE INDEX intents_queue_order ON intents(thread_id,position,id) WHERE status IN ('pending','queued');
";

/// Initializes a fresh engine schema or verifies an existing version-9 layout.
pub fn migrate(conn: &Arc<Connection>) -> Result<(), String> {
    conn.exec(
        "CREATE TABLE IF NOT EXISTS engine_schema_version (
            id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL
        )",
    )
    .map_err(|error| error.to_string())?;
    let version = conn
        .prepare("SELECT version FROM engine_schema_version WHERE id = 1")
        .map_err(|error| error.to_string())?
        .step()
        .map_err(|error| error.to_string())?;
    if let Some(row) = version {
        let stored = match row.first() {
            Some(Value::Integer(n)) => Some(*n),
            _ => None,
        };
        if stored != Some(ENGINE_SCHEMA_VERSION) {
            return Err(format!(
                "Unsupported engine schema version: expected {ENGINE_SCHEMA_VERSION}"
            ));
        }
        require_columns(conn, "engine_sessions", ENGINE_SESSION_COLUMNS)?;
        require_columns(conn, "intents", INTENT_COLUMNS)?;
        if table_exists(conn, "engine_queue")? {
            require_columns(conn, "engine_queue", QUEUE_COLUMNS)?;
        } else {
            conn.exec(
                "CREATE TABLE engine_queue (
                    thread_id TEXT PRIMARY KEY REFERENCES threads(id), revision INTEGER NOT NULL DEFAULT 0,
                    paused INTEGER NOT NULL DEFAULT 0, reason TEXT, limited INTEGER NOT NULL DEFAULT 0,
                    reset_at INTEGER, resume_at INTEGER, timer_action TEXT, continuation TEXT, trigger TEXT,
                    hold_token INTEGER NOT NULL DEFAULT 0, last_failure TEXT, preferences JSON,
                    exited INTEGER NOT NULL DEFAULT 0
                )",
            )
            .map_err(|error| error.to_string())?;
        }
        return Ok(());
    }
    let legacy = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN (
                'thread_state', 'engine_sessions', 'intents', 'engine_state_records',
                'engine_state_appends', 'engine_slots', 'engine_raw_blobs'
            ) LIMIT 1",
        )
        .map_err(|error| error.to_string())?
        .step()
        .map_err(|error| error.to_string())?;
    if legacy.is_some() {
        return Err(format!(
            "Unsupported engine schema version: expected {ENGINE_SCHEMA_VERSION}"
        ));
    }
    conn.exec("BEGIN IMMEDIATE")
        .map_err(|error| error.to_string())?;
    let setup = (|| -> Result<(), String> {
        conn.exec(FRESH_ENGINE_DDL)
            .map_err(|error| error.to_string())?;
        let insert = conn
            .prepare("INSERT INTO engine_schema_version VALUES (1, ?)")
            .map_err(|error| error.to_string())?;
        insert
            .bind(&[Some(Value::Integer(ENGINE_SCHEMA_VERSION))])
            .map_err(|error| error.to_string())?;
        insert.step().map_err(|error| error.to_string())?;
        Ok(())
    })();
    match setup {
        Ok(()) => conn.exec("COMMIT").map_err(|error| error.to_string()),
        Err(error) => {
            let _ = conn.exec("ROLLBACK");
            Err(error)
        }
    }
}

fn table_exists(conn: &Arc<Connection>, table: &str) -> Result<bool, String> {
    let stmt = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .map_err(|error| error.to_string())?;
    stmt.bind(&[Some(Value::Text(table.to_owned()))])
        .map_err(|error| error.to_string())?;
    Ok(stmt.step().map_err(|error| error.to_string())?.is_some())
}

fn require_columns(conn: &Arc<Connection>, table: &str, required: &[&str]) -> Result<(), String> {
    let stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let mut present = HashSet::new();
    while let Some(row) = stmt.step().map_err(|error| error.to_string())? {
        if let Some(Value::Text(name)) = row.get(1) {
            present.insert(name.clone());
        }
    }
    let missing: Vec<&str> = required
        .iter()
        .copied()
        .filter(|name| !present.contains(*name))
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "The engine table {table} lacks {}",
            missing.join(", ")
        ));
    }
    Ok(())
}
