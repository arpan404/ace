//! Cases (ADR 0204 §1): runs the person kept as tests, each its bot's own, kept here on the bot's
//! machine and moved with it (ADR 0187), never sent anywhere else. What a case holds is
//! `spade_core::quality::case`'s, already redacted when it reaches here.

use rusqlite::{OptionalExtension, Row, params};

use crate::{Result, Store};

/// The schema step for cases: one new, empty table, so opening stays instant (ADR 0170).
pub(crate) const SCHEMA: &str = "
    CREATE TABLE cases (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
        reply TEXT NOT NULL,
        mark TEXT,
        body TEXT NOT NULL,
        made_ms INTEGER NOT NULL,
        UNIQUE (agent_id, reply)
    );
    CREATE INDEX cases_by_agent ON cases (agent_id, made_ms DESC);
";

/// A case of no bot still arriving (ADR 0187).
const LIVE_CASE: &str =
    "c.agent_id NOT IN (SELECT id FROM move_claims WHERE kind = 'agent' AND hidden = 1)";

const COLUMNS: &str = "c.id, c.agent_id, c.reply, c.mark, c.body, c.made_ms";

/// A kept case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredCase {
    pub id: String,
    pub agent: String,
    pub reply: String,
    /// `right`, `wrong`, or none.
    pub mark: Option<String>,
    /// The case as JSON.
    pub body: String,
    pub made_ms: i64,
}

fn stored(row: &Row<'_>) -> rusqlite::Result<StoredCase> {
    Ok(StoredCase {
        id: row.get(0)?,
        agent: row.get(1)?,
        reply: row.get(2)?,
        mark: row.get(3)?,
        body: row.get(4)?,
        made_ms: row.get(5)?,
    })
}

impl Store {
    /// Keeps `case` unless its bot already kept that reply: the case the reply has, and whether
    /// it is new.
    pub fn save_case(&self, case: &StoredCase) -> Result<(StoredCase, bool)> {
        let connection = self.lock()?;
        let inserted = connection.execute(
            "INSERT OR IGNORE INTO cases (id, agent_id, reply, mark, body, made_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                case.id,
                case.agent,
                case.reply,
                case.mark,
                case.body,
                case.made_ms
            ],
        )?;
        let kept = connection.query_row(
            &format!("SELECT {COLUMNS} FROM cases c WHERE c.agent_id = ?1 AND c.reply = ?2"),
            params![case.agent, case.reply],
            stored,
        )?;
        Ok((kept, inserted > 0))
    }

    /// Bot `agent`'s case `id`.
    pub fn case(&self, agent: &str, id: &str) -> Result<Option<StoredCase>> {
        Ok(self
            .lock()?
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM cases c WHERE c.id = ?1 AND c.agent_id = ?2 AND {LIVE_CASE}"
                ),
                params![id, agent],
                stored,
            )
            .optional()?)
    }

    /// Bot `agent`'s cases, newest first, at most `limit`.
    pub fn cases(&self, agent: &str, limit: usize) -> Result<Vec<StoredCase>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {COLUMNS} FROM cases c WHERE c.agent_id = ?1 AND {LIVE_CASE}
             ORDER BY c.made_ms DESC, c.id DESC LIMIT ?2"
        ))?;
        let rows = statement.query_map(
            params![agent, i64::try_from(limit).unwrap_or(i64::MAX)],
            stored,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Removes bot `agent`'s case `id`; whether there was one.
    pub fn delete_case(&self, agent: &str, id: &str) -> Result<bool> {
        let removed = self.lock()?.execute(
            "DELETE FROM cases WHERE id = ?1 AND agent_id = ?2",
            params![id, agent],
        )?;
        Ok(removed > 0)
    }
}

#[cfg(test)]
mod tests;
