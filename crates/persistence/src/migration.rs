use crate::PersistenceError;
use rusqlite::Connection;

pub fn open_event_store(path: impl AsRef<std::path::Path>) -> Result<Connection, PersistenceError> {
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    migrate(&connection)?;
    Ok(connection)
}

pub fn migrate(connection: &Connection) -> Result<(), PersistenceError> {
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS projection_projects (
            project_id TEXT PRIMARY KEY,
            project_json TEXT NOT NULL,
            workspace_root TEXT NOT NULL,
            deleted_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_projects_workspace_active
        ON projection_projects(workspace_root)
        WHERE deleted_at IS NULL;

        CREATE TABLE IF NOT EXISTS projection_threads (
            thread_id TEXT PRIMARY KEY,
            thread_json TEXT NOT NULL,
            project_id TEXT NOT NULL,
            deleted_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_projection_threads_project
        ON projection_threads(project_id);

        CREATE TABLE IF NOT EXISTS projection_checkpoints (
            thread_id TEXT NOT NULL,
            checkpoint_turn_count INTEGER NOT NULL,
            checkpoint_json TEXT NOT NULL,
            PRIMARY KEY(thread_id, checkpoint_turn_count)
        );
        CREATE INDEX IF NOT EXISTS idx_projection_checkpoints_thread
        ON projection_checkpoints(thread_id, checkpoint_turn_count);

        CREATE TABLE IF NOT EXISTS provider_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL,
            event_json TEXT NOT NULL,
            projection_deltas_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE INDEX IF NOT EXISTS idx_provider_events_provider_sequence
        ON provider_events(provider, sequence);

        CREATE TABLE IF NOT EXISTS provider_server_requests (
            provider TEXT NOT NULL,
            request_id TEXT NOT NULL,
            request_json TEXT,
            status TEXT NOT NULL,
            decision_json TEXT,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            resolved_at TEXT,
            PRIMARY KEY(provider, request_id)
        );
        CREATE INDEX IF NOT EXISTS idx_provider_server_requests_status
        ON provider_server_requests(provider, status, created_at);

        CREATE TABLE IF NOT EXISTS composer_drafts (
            thread_id TEXT PRIMARY KEY,
            draft_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS thread_drafts (
            thread_id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            draft_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_drafts_project
        ON thread_drafts(project_id);

        CREATE TABLE IF NOT EXISTS sidebar_metadata (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            metadata_json TEXT NOT NULL
        );
        ",
    )?;
    ensure_column(
        connection,
        "provider_events",
        "projection_deltas_json",
        "ALTER TABLE provider_events ADD COLUMN projection_deltas_json TEXT NOT NULL DEFAULT '[]'",
    )?;
    Ok(())
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    alter_sql: &str,
) -> Result<(), PersistenceError> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let existing: String = row.get(1)?;
        if existing == column {
            return Ok(());
        }
    }
    connection.execute_batch(alter_sql)?;
    Ok(())
}
