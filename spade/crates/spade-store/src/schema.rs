//! The database layout and its forward migrations, tracked in `PRAGMA user_version`.

use rusqlite::Connection;

/// Each entry moves the schema up one version. Never edit a shipped entry; add a new one.
const MIGRATIONS: &[&str] = &["
    CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL
    );
    CREATE INDEX conversations_by_update ON conversations (updated_ms DESC);
    CREATE TABLE events (
        conversation_id TEXT NOT NULL REFERENCES conversations (id),
        seq INTEGER NOT NULL,
        at_ms INTEGER NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (conversation_id, seq)
    ) WITHOUT ROWID;
    CREATE TABLE spend (
        id INTEGER PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        model TEXT NOT NULL,
        cost_micros INTEGER NOT NULL,
        at_ms INTEGER NOT NULL
    );
    CREATE INDEX spend_by_time ON spend (at_ms);
"];

pub fn prepare(connection: &mut Connection) -> rusqlite::Result<()> {
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    let version: usize =
        connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))? as usize;
    for (index, migration) in MIGRATIONS.iter().enumerate().skip(version) {
        let tx = connection.transaction()?;
        tx.execute_batch(migration)?;
        tx.pragma_update(None, "user_version", (index + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}
