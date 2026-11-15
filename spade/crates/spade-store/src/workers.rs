//! Orchestration trees (ADR 0161): the events that link worker bots to their parents, read in one
//! pass when Spade starts so the tree can be folded without loading every conversation, and the
//! spend of a subtree.

use rusqlite::params;
use spade_core::Event;

use crate::{Result, Store};

impl Store {
    /// Every `worker_of`, `worker_budget` and `worker_detached` event, by conversation in order.
    pub fn worker_links(&self) -> Result<Vec<(String, Event)>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT conversation_id, body FROM events
             WHERE body LIKE '{\"type\":\"worker_%'
               AND json_extract(body, '$.type') IN ('worker_of', 'worker_budget', 'worker_detached')
             ORDER BY conversation_id, seq",
        )?;
        let rows = statement.query_map([], |row| {
            let conversation: String = row.get(0)?;
            let body: String = row.get(1)?;
            Ok((conversation, body))
        })?;
        let mut links = Vec::new();
        for row in rows {
            let (conversation, body) = row?;
            if let Ok(value) = serde_json::from_str(&body) {
                links.push((conversation, Event::from_json(value)));
            }
        }
        Ok(links)
    }

    /// The conversations that noted an ace child as being stopped (ADR 0161), each once: where
    /// a cancel ace hasn't confirmed may be owed after a restart.
    pub fn ace_stops(&self) -> Result<Vec<String>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT DISTINCT conversation_id FROM events
             WHERE body LIKE '{\"type\":\"worker_reported\"%'
               AND json_extract(body, '$.kind') = 'ace'
               AND json_extract(body, '$.state') = 'stopping'
             ORDER BY conversation_id",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    /// What `conversations` spent together since `since_ms`.
    pub fn spent_by_all(&self, conversations: &[String], since_ms: i64) -> Result<u64> {
        if conversations.is_empty() {
            return Ok(0);
        }
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT COALESCE(SUM(cost_micros), 0) FROM spend
             WHERE at_ms >= ?2 AND conversation_id = ?1",
        )?;
        let mut total: i64 = 0;
        for conversation in conversations {
            let spent: i64 =
                statement.query_row(params![conversation, since_ms], |row| row.get(0))?;
            total = total.saturating_add(spent);
        }
        Ok(u64::try_from(total).unwrap_or(0))
    }
}
