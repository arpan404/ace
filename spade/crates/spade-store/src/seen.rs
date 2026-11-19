//! How far the person has read each conversation (a bot's or a group's): one cursor per
//! conversation, the `seq` of the last event they saw. It only moves forward and goes with its
//! conversation. Never part of the event log, so nothing the model reads changes.

use rusqlite::{OptionalExtension, params};

use crate::{Result, Store};

/// The schema step that adds seen cursors. What a database already holds counts as seen, so an
/// update doesn't mark every conversation new.
pub(crate) const SCHEMA: &str = "
    CREATE TABLE seen (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations (id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        at_ms INTEGER NOT NULL
    ) WITHOUT ROWID;
    INSERT INTO seen (conversation_id, seq, at_ms)
        SELECT conversation_id, MAX(seq), 0 FROM events GROUP BY conversation_id;
";

impl Store {
    /// Marks `conversation` seen up to `seq` (its last event when `None`, and never past it).
    /// A cursor never moves back. Answers the cursor now, or `None` for no such conversation.
    pub fn mark_seen(
        &self,
        conversation: &str,
        seq: Option<i64>,
        at_ms: i64,
    ) -> Result<Option<i64>> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let exists: Option<i64> = tx
            .query_row(
                &format!(
                    "SELECT 1 FROM conversations WHERE id = ?1
                     AND id NOT IN {}",
                    crate::gate::ARRIVING_CONVERSATIONS
                ),
                params![conversation],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Ok(None);
        }
        let last: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM events WHERE conversation_id = ?1",
            params![conversation],
            |row| row.get(0),
        )?;
        let wanted = seq.map_or(last, |seq| seq.clamp(0, last));
        tx.execute(
            "INSERT INTO seen (conversation_id, seq, at_ms) VALUES (?1, ?2, ?3)
             ON CONFLICT (conversation_id) DO UPDATE
             SET seq = MAX(seq, excluded.seq),
                 at_ms = CASE WHEN excluded.seq > seq THEN excluded.at_ms ELSE at_ms END",
            params![conversation, wanted, at_ms],
        )?;
        let now: i64 = tx.query_row(
            "SELECT seq FROM seen WHERE conversation_id = ?1",
            params![conversation],
            |row| row.get(0),
        )?;
        tx.commit()?;
        Ok(Some(now))
    }

    /// The `seq` the person has seen `conversation` up to; `None` when never marked.
    pub fn seen(&self, conversation: &str) -> Result<Option<i64>> {
        Ok(self
            .lock()?
            .query_row(
                &format!(
                    "SELECT seq FROM seen WHERE conversation_id = ?1 AND conversation_id NOT IN {}",
                    crate::gate::ARRIVING_CONVERSATIONS
                ),
                params![conversation],
                |row| row.get(0),
            )
            .optional()?)
    }
}
