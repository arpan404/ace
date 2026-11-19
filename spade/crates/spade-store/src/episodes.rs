//! Episodes (ADR 0164): one per closed goal, searched with FTS5. What an episode holds is
//! `spade_core::knowledge::episode`'s; this keeps them, once per goal.

use rusqlite::{OptionalExtension, Row, params};

use crate::gate::ARRIVING_CONVERSATIONS;
use crate::{Result, Store};

/// An episode of no bot still arriving (ADR 0187).
const LIVE_EPISODE: &str =
    "e.agent_id NOT IN (SELECT id FROM move_claims WHERE kind = 'agent' AND hidden = 1)";

/// The schema step's part for episodes. Also rebuilds the past-text index, which now holds
/// compaction summaries too: it refills from the event log as it is searched.
const SCHEMA: &str = "
    CREATE TABLE episodes (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        title TEXT NOT NULL,
        outcome TEXT NOT NULL,
        body TEXT NOT NULL,
        text TEXT NOT NULL,
        untrusted INTEGER NOT NULL,
        cost_micros INTEGER NOT NULL,
        started_ms INTEGER NOT NULL,
        closed_ms INTEGER NOT NULL,
        UNIQUE (conversation_id, goal)
    );
    CREATE INDEX episodes_by_agent ON episodes (agent_id, closed_ms DESC);
    CREATE VIRTUAL TABLE episodes_search USING fts5 (
        text, content = 'episodes', content_rowid = 'rowid', tokenize = 'porter unicode61'
    );
    CREATE TRIGGER episodes_added AFTER INSERT ON episodes BEGIN
        INSERT INTO episodes_search (rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER episodes_removed AFTER DELETE ON episodes BEGIN
        INSERT INTO episodes_search (episodes_search, rowid, text) VALUES ('delete', old.rowid, old.text);
    END;
    DELETE FROM history_search;
    DELETE FROM history_indexed;
";

/// Adds the episodes' tables, in the knowledge migration's transaction.
pub(crate) fn create(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(SCHEMA)
}

/// A stored episode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredEpisode {
    pub id: String,
    pub agent: String,
    pub conversation: String,
    pub goal: String,
    pub title: String,
    pub outcome: String,
    /// The episode as JSON.
    pub body: String,
    pub untrusted: bool,
    pub cost_micros: u64,
    pub started_ms: i64,
    pub closed_ms: i64,
}

/// An episode to keep.
#[derive(Debug, Clone, Copy)]
pub struct NewEpisode<'a> {
    pub id: &'a str,
    pub agent: &'a str,
    pub conversation: &'a str,
    pub goal: &'a str,
    pub title: &'a str,
    pub outcome: &'a str,
    pub body: &'a str,
    pub text: &'a str,
    pub untrusted: bool,
    pub cost_micros: u64,
    pub started_ms: i64,
    pub closed_ms: i64,
}

const COLUMNS: &str = "e.id, e.agent_id, e.conversation_id, e.goal, e.title, e.outcome, e.body, \
                       e.untrusted, e.cost_micros, e.started_ms, e.closed_ms";

fn episode(row: &Row<'_>) -> rusqlite::Result<StoredEpisode> {
    Ok(StoredEpisode {
        id: row.get(0)?,
        agent: row.get(1)?,
        conversation: row.get(2)?,
        goal: row.get(3)?,
        title: row.get(4)?,
        outcome: row.get(5)?,
        body: row.get(6)?,
        untrusted: row.get::<_, i64>(7)? != 0,
        cost_micros: u64::try_from(row.get::<_, i64>(8)?).unwrap_or(0),
        started_ms: row.get(9)?,
        closed_ms: row.get(10)?,
    })
}

impl Store {
    /// Keeps an episode unless its goal has one: the episode the goal has, and whether it is new.
    pub fn save_episode(&self, new: NewEpisode<'_>) -> Result<(StoredEpisode, bool)> {
        let connection = self.lock()?;
        let inserted = connection.execute(
            "INSERT OR IGNORE INTO episodes (id, agent_id, conversation_id, goal, title, outcome,
                 body, text, untrusted, cost_micros, started_ms, closed_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                new.id,
                new.agent,
                new.conversation,
                new.goal,
                new.title,
                new.outcome,
                new.body,
                new.text,
                i64::from(new.untrusted),
                i64::try_from(new.cost_micros).unwrap_or(i64::MAX),
                new.started_ms,
                new.closed_ms
            ],
        )?;
        let kept = connection.query_row(
            &format!(
                "SELECT {COLUMNS} FROM episodes e WHERE e.conversation_id = ?1 AND e.goal = ?2"
            ),
            params![new.conversation, new.goal],
            episode,
        )?;
        Ok((kept, inserted > 0))
    }

    pub fn episode(&self, id: &str) -> Result<Option<StoredEpisode>> {
        Ok(self
            .lock()?
            .query_row(
                &format!("SELECT {COLUMNS} FROM episodes e WHERE e.id = ?1 AND {LIVE_EPISODE}"),
                params![id],
                episode,
            )
            .optional()?)
    }

    /// The episodes of `agents`, newest first, at most `limit`; with `query` (FTS5) only those
    /// matching it, best first.
    pub fn episodes(
        &self,
        agents: &[String],
        query: Option<&str>,
        limit: usize,
    ) -> Result<Vec<StoredEpisode>> {
        let connection = self.lock()?;
        let bases = serde_json::to_string(agents).unwrap_or_else(|_| "[]".to_owned());
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let found = match query {
            None => {
                let mut statement = connection.prepare(&format!(
                    "SELECT {COLUMNS} FROM episodes e
                     WHERE e.agent_id IN (SELECT value FROM json_each(?1)) AND {LIVE_EPISODE}
                     ORDER BY e.closed_ms DESC, e.id DESC LIMIT ?2"
                ))?;
                let rows = statement.query_map(params![bases, limit], episode)?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            }
            Some(query) => {
                let mut statement = connection.prepare(&format!(
                    "SELECT {COLUMNS} FROM episodes_search
                     JOIN episodes e ON e.rowid = episodes_search.rowid
                     WHERE episodes_search MATCH ?1
                       AND e.agent_id IN (SELECT value FROM json_each(?2)) AND {LIVE_EPISODE}
                     ORDER BY bm25(episodes_search) LIMIT ?3"
                ))?;
                let rows = statement.query_map(params![query, bases, limit], episode)?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            }
        };
        Ok(found)
    }

    /// How many episodes the bases of `agents` hold.
    pub fn count_episodes(&self, agents: &[String]) -> Result<usize> {
        let bases = serde_json::to_string(agents).unwrap_or_else(|_| "[]".to_owned());
        let count: i64 = self.lock()?.query_row(
            &format!(
                "SELECT COUNT(*) FROM episodes e WHERE e.agent_id IN (SELECT value FROM json_each(?1))
                 AND {LIVE_EPISODE}"
            ),
            params![bases],
            |row| row.get(0),
        )?;
        Ok(usize::try_from(count).unwrap_or(0))
    }

    /// What conversation `conversation` spent between two times, inclusive.
    pub fn spent_between(&self, conversation: &str, from_ms: i64, to_ms: i64) -> Result<u64> {
        let spent: i64 = self.lock()?.query_row(
            &format!(
                "SELECT COALESCE(SUM(cost_micros), 0) FROM spend
                 WHERE conversation_id = ?1 AND at_ms >= ?2 AND at_ms <= ?3
                 AND conversation_id NOT IN {ARRIVING_CONVERSATIONS}"
            ),
            params![conversation, from_ms, to_ms],
            |row| row.get(0),
        )?;
        Ok(u64::try_from(spent).unwrap_or(0))
    }
}
