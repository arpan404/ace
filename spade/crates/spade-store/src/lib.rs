//! Spade's storage, one SQLite file: agents (ADR 0126/0127), each with exactly one conversation,
//! each conversation's append-only event log, the person's endpoints and models, settings, and
//! the spending ledger. The event log is the source of truth; the conversation row keeps the
//! title and last update for the list. Keys are never stored here (ADR 0119).

mod agents;
mod digests;
mod endpoints;
mod episodes;
mod gate;
mod helpers;
mod knowledge;
mod moves;
mod notes;
mod oversight;
mod routines;
mod schema;
mod seen;
mod skills;
mod spend;
mod teams;
mod workers;

pub use agents::{Agent, BOT_RECIPE, NewAgent, recipe_key};
pub use digests::{DIGESTS, NewDigest, StoredDigest, digests_key};
pub use endpoints::{StoredEndpoint, StoredModel};
pub use episodes::{NewEpisode, StoredEpisode};
pub use helpers::StoredHelper;
pub use knowledge::{Changed, EntryChange, EntryLink, NewEntry, StoredEntry, Written};
pub use moves::{
    Arrived, Begun, Cursor, Cutover, EVENTS, Handover, MOVE_BATCH, MOVE_BATCH_BYTES, MOVE_TABLES,
    MainActive, Merge, MoveTable, OPEN_MOVE, PER_BOT_SETTINGS, Row, RowSums, Selection, Stage,
    StoredMove, TableSum, arrival_state, move_table, open_state,
};
pub use notes::{HistoryMatch, HistoryWindow, NewNote, Notes, Saved, StoredNote, Updated};
pub use oversight::{ACTIVITY_TYPES, AgentSpend, OVERSIGHT, agent_key};
pub use routines::{HEARTBEAT, ROUTINE, StoredRoutine, StoredRun};
pub use skills::{SkillOrigin, SkillUse, StoredSkill};
pub use spend::{MODEL_ROLES, roles_key};
pub use teams::{Delivered, Delivery, InboxEntry, OutboxEntry, StoredGroup, StoredMember};

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use gate::ARRIVING_CONVERSATIONS;
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
    /// Only its arrival moves an arriving move on (ADR 0187).
    #[error("move {0} is arriving; only its arrival moves it on")]
    Arriving(String),
    /// No event number is left in the conversation.
    #[error("conversation {0} has no event numbers left")]
    NoSeqLeft(String),
    /// An arrival's placed files go back before its rows and its gate (ADR 0187).
    #[error("move {0} still has files placed; they go back first")]
    FilesPlaced(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// The largest event number a conversation reaches (2^53, exact in every client's numbers); a
/// move brings none past it (ADR 0187).
pub const MOST_SEQ: i64 = 1 << 53;

/// The store's connection while what is written through it must reach the disk before each
/// commit returns; back to the everyday `NORMAL` once let go.
pub(crate) struct Durable<'a>(MutexGuard<'a, Connection>);

impl std::ops::Deref for Durable<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.0
    }
}

impl std::ops::DerefMut for Durable<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut self.0
    }
}

impl Drop for Durable<'_> {
    fn drop(&mut self) {
        let _ = self.0.pragma_update(None, "synchronous", "NORMAL");
    }
}

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
        // The arriving gate (ADR 0187), held by SQLite itself on this connection.
        gate::install(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// The schema version this build brings a database up to: the number of its migrations,
    /// which a release publishes in `ace-data.json` (ADR 0177).
    pub fn schema_version() -> usize {
        schema::current_version()
    }

    /// Whether this build can use the existing database at `path`: brings that file's schema up
    /// to date and checks its integrity. Run against a copy (an updater's snapshot): it writes to
    /// the file. Never creates one. The error is one line saying why not.
    pub fn check(path: &Path) -> std::result::Result<(), String> {
        let flags =
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let one_line = |e: rusqlite::Error| e.to_string().replace('\n', " ");
        let mut connection = Connection::open_with_flags(path, flags)
            .map_err(|e| format!("cannot open {}: {}", path.display(), one_line(e)))?;
        let found = schema::version(&connection)
            .map_err(|e| format!("not a Spade database: {}", one_line(e)))?;
        let known = schema::current_version();
        if found > known {
            return Err(format!(
                "the database is at schema {found}, newer than this Spade's {known}"
            ));
        }
        schema::prepare(&mut connection)
            .map_err(|e| format!("migrating failed: {}", one_line(e)))?;
        let problems: Vec<String> = {
            let mut statement = connection
                .prepare("PRAGMA integrity_check")
                .map_err(|e| format!("cannot check integrity: {}", one_line(e)))?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| format!("cannot check integrity: {}", one_line(e)))?;
            rows.collect::<rusqlite::Result<_>>()
                .map_err(|e| format!("cannot check integrity: {}", one_line(e)))?
        };
        if problems != ["ok"] {
            return Err(format!("integrity check failed: {}", problems.join("; ")));
        }
        // Every table this build reads must be there and readable.
        for table in [
            "conversations",
            "events",
            "spend",
            "agents",
            "endpoints",
            "models",
            "settings",
            "notes",
            "routines",
            "routine_runs",
            "skills",
            "skill_uses",
            "helpers",
        ] {
            connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get::<_, i64>(0)
                })
                .map_err(|e| format!("table {table} is unreadable: {}", one_line(e)))?;
        }
        Ok(())
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection.lock().map_err(|_| StoreError::Poisoned)
    }

    /// The connection, every commit made through it synced to disk before it returns
    /// (`synchronous = FULL`): for what a move acknowledges, which a power loss must not undo.
    pub(crate) fn lock_durable(&self) -> Result<Durable<'_>> {
        let connection = self.lock()?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        Ok(Durable(connection))
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

    /// Every conversation, most recently updated first. Helpers' hidden conversations
    /// (ADR 0152) are left out: [`Store::helpers`] lists them.
    pub fn conversations(&self) -> Result<Vec<Conversation>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT id, title, created_ms, updated_ms FROM conversations
             WHERE id NOT IN (SELECT conversation_id FROM helpers)
               AND id NOT IN {ARRIVING_CONVERSATIONS}
             ORDER BY updated_ms DESC, id DESC"
        ))?;
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
        if gate::arriving(&connection, gate::CONVERSATION, id)? {
            return Ok(None);
        }
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
        let mut stored = self.append_all(conversation, std::slice::from_ref(event), now_ms)?;
        stored
            .pop()
            .ok_or_else(|| StoreError::NoConversation(conversation.to_owned()))
    }

    /// Appends `events` in order, all or none: a crash never keeps some without the rest.
    pub fn append_all(
        &self,
        conversation: &str,
        events: &[Event],
        now_ms: i64,
    ) -> Result<Vec<StoredEvent>> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let stored = append_in(&tx, conversation, events, now_ms)?;
        tx.commit()?;
        Ok(stored)
    }

    /// The conversation's events numbered after `after`, in order.
    pub fn events(&self, conversation: &str, after: i64) -> Result<Vec<StoredEvent>> {
        Ok(self.events_weighed(conversation, after)?.0)
    }

    /// [`Store::events`], with the stored size of what was read in bytes: a measure of what the
    /// events take in memory, for a reader that keeps them (the engine's running turn).
    pub fn events_weighed(
        &self,
        conversation: &str,
        after: i64,
    ) -> Result<(Vec<StoredEvent>, usize)> {
        let connection = self.lock()?;
        if gate::arriving(&connection, gate::CONVERSATION, conversation)? {
            return Ok((Vec::new(), 0));
        }
        let mut statement = connection.prepare(
            "SELECT seq, at_ms, body FROM events
             WHERE conversation_id = ?1 AND seq > ?2 ORDER BY seq",
        )?;
        let rows = statement.query_map(params![conversation, after], |row| {
            let body: String = row.get(2)?;
            let bytes = body.len();
            let stored = StoredEvent {
                seq: row.get(0)?,
                at_ms: row.get(1)?,
                event: Event::from_json(
                    serde_json::from_str(&body).unwrap_or(serde_json::Value::String(body)),
                ),
            };
            Ok((stored, bytes))
        })?;
        let mut events = Vec::new();
        let mut bytes = 0;
        for row in rows {
            let (stored, size) = row?;
            events.push(stored);
            bytes += size;
        }
        Ok((events, bytes))
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
        let connection = self.lock()?;
        if gate::arriving(&connection, gate::CONVERSATION, conversation)? {
            return Err(StoreError::NoConversation(conversation.to_owned()));
        }
        connection.execute(
            "INSERT INTO spend (conversation_id, model, cost_micros, at_ms) VALUES (?1, ?2, ?3, ?4)",
            params![conversation, model, cost, now_ms],
        )?;
        Ok(())
    }

    /// Total spent from `since_ms` on.
    pub fn spent_since(&self, since_ms: i64) -> Result<u64> {
        let total: i64 = self.lock()?.query_row(
            &format!(
                "SELECT COALESCE(SUM(cost_micros), 0) FROM spend WHERE at_ms >= ?1
                 AND conversation_id NOT IN {ARRIVING_CONVERSATIONS}"
            ),
            params![since_ms],
            |row| row.get(0),
        )?;
        Ok(u64::try_from(total).unwrap_or(0))
    }
}

/// Appends `events` to `conversation` inside `tx`, numbered after the rest.
pub(crate) fn append_in(
    tx: &rusqlite::Transaction<'_>,
    conversation: &str,
    events: &[Event],
    now_ms: i64,
) -> Result<Vec<StoredEvent>> {
    let exists: bool = tx
        .query_row(
            "SELECT 1 FROM conversations WHERE id = ?1",
            params![conversation],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    // Nothing is written to a conversation still arriving (ADR 0187).
    if !exists || gate::arriving(tx, gate::CONVERSATION, conversation)? {
        return Err(StoreError::NoConversation(conversation.to_owned()));
    }
    let mut seq: i64 = tx.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM events WHERE conversation_id = ?1",
        params![conversation],
        |row| row.get(0),
    )?;
    let mut stored = Vec::with_capacity(events.len());
    for event in events {
        seq = seq
            .checked_add(1)
            .filter(|next| *next <= MOST_SEQ)
            .ok_or_else(|| StoreError::NoSeqLeft(conversation.to_owned()))?;
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
        stored.push(StoredEvent {
            seq,
            at_ms: now_ms,
            event: event.clone(),
        });
    }
    Ok(stored)
}

#[cfg(test)]
mod tests;
