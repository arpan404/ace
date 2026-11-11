//! Spade's storage, one SQLite file: conversations, each conversation's append-only event log, and
//! the spending ledger. The event log is the source of truth; the conversation row keeps the
//! title and last update for the list.

mod schema;

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, params};
use spade_core::Event;
use spade_core::event::Known;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("conversation {0} does not exist")]
    NoConversation(String),
    #[error("conversation {0} already exists")]
    Exists(String),
    #[error("storage failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("the storage lock was poisoned by a crash")]
    Poisoned,
}

pub type Result<T> = std::result::Result<T, StoreError>;

#[derive(Debug, Clone, PartialEq)]
pub struct StoredEvent {
    pub seq: i64,
    pub at_ms: i64,
    pub event: Event,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conversation {
    pub id: String,
    pub title: Option<String>,
    pub created_ms: i64,
    pub updated_ms: i64,
}

pub struct Store {
    connection: Mutex<Connection>,
}

impl Store {
    /// Opens (creating if needed) the database at `path` and brings its schema up to date.
    pub fn open(path: &Path) -> Result<Self> {
        let mut connection = Connection::open(path)?;
        schema::prepare(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection.lock().map_err(|_| StoreError::Poisoned)
    }

    pub fn create_conversation(&self, id: &str, now_ms: i64) -> Result<()> {
        let connection = self.lock()?;
        let inserted = connection.execute(
            "INSERT OR IGNORE INTO conversations (id, title, created_ms, updated_ms)
             VALUES (?1, NULL, ?2, ?2)",
            params![id, now_ms],
        )?;
        if inserted == 0 {
            return Err(StoreError::Exists(id.to_owned()));
        }
        Ok(())
    }

    /// Every conversation, most recently updated first.
    pub fn conversations(&self) -> Result<Vec<Conversation>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, title, created_ms, updated_ms FROM conversations
             ORDER BY updated_ms DESC, id DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(Conversation {
                id: row.get(0)?,
                title: row.get(1)?,
                created_ms: row.get(2)?,
                updated_ms: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn conversation(&self, id: &str) -> Result<Option<Conversation>> {
        let connection = self.lock()?;
        Ok(connection
            .query_row(
                "SELECT id, title, created_ms, updated_ms FROM conversations WHERE id = ?1",
                params![id],
                |row| {
                    Ok(Conversation {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        created_ms: row.get(2)?,
                        updated_ms: row.get(3)?,
                    })
                },
            )
            .optional()?)
    }

    /// Appends `event` as the conversation's next numbered event.
    pub fn append(&self, conversation: &str, event: &Event, now_ms: i64) -> Result<StoredEvent> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let exists: bool = tx
            .query_row(
                "SELECT 1 FROM conversations WHERE id = ?1",
                params![conversation],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !exists {
            return Err(StoreError::NoConversation(conversation.to_owned()));
        }
        let seq: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE conversation_id = ?1",
            params![conversation],
            |row| row.get(0),
        )?;
        tx.execute(
            "INSERT INTO events (conversation_id, seq, at_ms, body) VALUES (?1, ?2, ?3, ?4)",
            params![conversation, seq, now_ms, event.to_json().to_string()],
        )?;
        match event {
            Event::Known(Known::Renamed { title }) => tx.execute(
                "UPDATE conversations SET updated_ms = ?2, title = ?3 WHERE id = ?1",
                params![conversation, now_ms, title],
            )?,
            _ => tx.execute(
                "UPDATE conversations SET updated_ms = ?2 WHERE id = ?1",
                params![conversation, now_ms],
            )?,
        };
        tx.commit()?;
        Ok(StoredEvent {
            seq,
            at_ms: now_ms,
            event: event.clone(),
        })
    }

    /// The conversation's events numbered after `after`, in order.
    pub fn events(&self, conversation: &str, after: i64) -> Result<Vec<StoredEvent>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT seq, at_ms, body FROM events
             WHERE conversation_id = ?1 AND seq > ?2 ORDER BY seq",
        )?;
        let rows = statement.query_map(params![conversation, after], |row| {
            let body: String = row.get(2)?;
            Ok(StoredEvent {
                seq: row.get(0)?,
                at_ms: row.get(1)?,
                event: Event::from_json(
                    serde_json::from_str(&body).unwrap_or(serde_json::Value::String(body)),
                ),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Records what a reply cost.
    pub fn record_spend(
        &self,
        conversation: &str,
        model: &str,
        cost_micros: u64,
        now_ms: i64,
    ) -> Result<()> {
        let cost = i64::try_from(cost_micros).unwrap_or(i64::MAX);
        self.lock()?.execute(
            "INSERT INTO spend (conversation_id, model, cost_micros, at_ms) VALUES (?1, ?2, ?3, ?4)",
            params![conversation, model, cost, now_ms],
        )?;
        Ok(())
    }

    /// Total spent from `since_ms` on.
    pub fn spent_since(&self, since_ms: i64) -> Result<u64> {
        let total: i64 = self.lock()?.query_row(
            "SELECT COALESCE(SUM(cost_micros), 0) FROM spend WHERE at_ms >= ?1",
            params![since_ms],
            |row| row.get(0),
        )?;
        Ok(u64::try_from(total).unwrap_or(0))
    }
}

#[cfg(test)]
mod tests;
