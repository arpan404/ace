use rusqlite::Connection;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PersistenceError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

pub fn open_event_store(path: impl AsRef<std::path::Path>) -> Result<Connection, PersistenceError> {
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    Ok(connection)
}
