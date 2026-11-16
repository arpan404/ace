//! Stored digests (ADR 0165): one row per digest, its JSON as built and its text. A digest is
//! kept beside its bot's conversation, never in it, so the bot never reads its own digests.
//! Rows go with their agent.

use rusqlite::{OptionalExtension, params};

use crate::{Result, Store};

/// The schema step that adds digests.
pub(crate) const SCHEMA: &str = "
    CREATE TABLE digests (
        id INTEGER PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        scheduled INTEGER NOT NULL,
        from_ms INTEGER NOT NULL,
        to_ms INTEGER NOT NULL,
        made_ms INTEGER NOT NULL,
        body TEXT NOT NULL,
        text TEXT NOT NULL,
        polished TEXT
    );
    CREATE INDEX digests_by_agent ON digests (agent_id, to_ms);
";

/// The service-wide digest settings' key.
pub const DIGESTS: &str = "digests";

/// One bot's digest settings' key.
pub fn digests_key(agent: &str) -> String {
    format!("{DIGESTS}:{agent}")
}

/// A digest to store.
#[derive(Debug, Clone)]
pub struct NewDigest<'a> {
    pub agent: &'a str,
    /// `task` or `tree`.
    pub kind: &'a str,
    /// Made by the schedule, so it moves it; one made on request doesn't.
    pub scheduled: bool,
    pub from_ms: i64,
    pub to_ms: i64,
    pub made_ms: i64,
    /// The digest as JSON.
    pub body: &'a str,
    pub text: &'a str,
    pub polished: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredDigest {
    pub id: i64,
    pub agent: String,
    pub kind: String,
    pub scheduled: bool,
    pub from_ms: i64,
    pub to_ms: i64,
    pub made_ms: i64,
    pub body: String,
    pub text: String,
    pub polished: Option<String>,
}

const COLUMNS: &str =
    "id, agent_id, kind, scheduled, from_ms, to_ms, made_ms, body, text, polished";

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredDigest> {
    Ok(StoredDigest {
        id: row.get(0)?,
        agent: row.get(1)?,
        kind: row.get(2)?,
        scheduled: row.get::<_, i64>(3)? != 0,
        from_ms: row.get(4)?,
        to_ms: row.get(5)?,
        made_ms: row.get(6)?,
        body: row.get(7)?,
        text: row.get(8)?,
        polished: row.get(9)?,
    })
}

impl Store {
    /// Stores a digest and answers its id.
    pub fn add_digest(&self, digest: &NewDigest<'_>) -> Result<i64> {
        let connection = self.lock()?;
        connection.execute(
            "INSERT INTO digests (agent_id, kind, scheduled, from_ms, to_ms, made_ms, body, text,
                                  polished)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                digest.agent,
                digest.kind,
                i64::from(digest.scheduled),
                digest.from_ms,
                digest.to_ms,
                digest.made_ms,
                digest.body,
                digest.text,
                digest.polished
            ],
        )?;
        Ok(connection.last_insert_rowid())
    }

    /// Digests newest first, after id `after` when given (so a client that reconnects reads
    /// what it missed), for one agent or all, at most `limit`.
    pub fn digests(
        &self,
        agent: Option<&str>,
        after: Option<i64>,
        limit: usize,
    ) -> Result<Vec<StoredDigest>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {COLUMNS} FROM digests
             WHERE (?1 IS NULL OR agent_id = ?1) AND id > ?2
             ORDER BY id DESC LIMIT ?3"
        ))?;
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let rows = statement.query_map(params![agent, after.unwrap_or(0), limit], row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn digest(&self, id: i64) -> Result<Option<StoredDigest>> {
        Ok(self
            .lock()?
            .query_row(
                &format!("SELECT {COLUMNS} FROM digests WHERE id = ?1"),
                params![id],
                row,
            )
            .optional()?)
    }

    /// Where `agent`'s last scheduled digest ended; `None` when it has none.
    pub fn last_scheduled_digest(&self, agent: &str) -> Result<Option<i64>> {
        Ok(self.lock()?.query_row(
            "SELECT MAX(to_ms) FROM digests WHERE agent_id = ?1 AND scheduled = 1",
            params![agent],
            |row| row.get(0),
        )?)
    }

    /// Where `agent`'s last digest of any kind ended; `None` when it has none.
    pub fn last_digest(&self, agent: &str) -> Result<Option<i64>> {
        Ok(self.lock()?.query_row(
            "SELECT MAX(to_ms) FROM digests WHERE agent_id = ?1",
            params![agent],
            |row| row.get(0),
        )?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NewAgent;

    type Result = std::result::Result<(), Box<dyn std::error::Error>>;

    fn digest<'a>(agent: &'a str, to_ms: i64, scheduled: bool) -> NewDigest<'a> {
        NewDigest {
            agent,
            kind: "tree",
            scheduled,
            from_ms: to_ms - 10,
            to_ms,
            made_ms: to_ms,
            body: "{}",
            text: "Builder: from 1 to 2",
            polished: None,
        }
    }

    fn store_with_bot(
        dir: &std::path::Path,
    ) -> std::result::Result<Store, Box<dyn std::error::Error>> {
        let store = Store::open(&dir.join("spade.sqlite"))?;
        let new = NewAgent {
            id: "a1",
            kind: "bot",
            name: "Builder",
            task: "",
            avatar: "{}",
            model: "fake/m",
            conversation: "c1",
        };
        store.create_agent(new, &[], 1)?;
        Ok(store)
    }

    #[test]
    fn digests_list_newest_first_and_after_a_cursor_and_go_with_their_agent() -> Result {
        let dir = tempfile::tempdir()?;
        let store = store_with_bot(dir.path())?;
        let first = store.add_digest(&digest("a1", 100, true))?;
        let second = store.add_digest(&digest("a1", 200, false))?;
        let ids: Vec<i64> = store
            .digests(Some("a1"), None, 10)?
            .iter()
            .map(|d| d.id)
            .collect();
        assert_eq!(ids, vec![second, first]);
        let after: Vec<i64> = store
            .digests(None, Some(first), 10)?
            .iter()
            .map(|d| d.id)
            .collect();
        assert_eq!(after, vec![second]);
        assert_eq!(store.last_scheduled_digest("a1")?, Some(100));
        assert_eq!(store.last_digest("a1")?, Some(200));
        assert_eq!(store.digest(first)?.map(|d| d.scheduled), Some(true));
        store.delete_agent("a1")?;
        assert!(store.digests(None, None, 10)?.is_empty());
        assert_eq!(store.last_digest("a1")?, None);
        Ok(())
    }
}
