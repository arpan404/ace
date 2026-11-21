//! Calls from the person's own agents outside Spade (ADR 0202 §3, §6), beside the inbox row
//! that delivered each. A grant's (grant, key) record is what its task id, its Stop and a retry
//! of its key rely on, so the inbox's own cleanup never takes one: an outside call's row and
//! its outcome stay while the call is open, and for [`KEEP_ENDED_MS`]'s worth of time after it
//! ended ([`Store::prune_outside`]).

use rusqlite::{OptionalExtension, params};

use crate::{Result, Store};

/// The sender every outside call's inbox row is stored under, its grant's id after it.
pub const OUTSIDE_HOSTS: &str = "ace:outside:";

/// Matches an outside row's `from_host` (the prefix holds no LIKE wildcard).
pub(crate) const OUTSIDE_LIKE: &str = "from_host LIKE 'ace:outside:%'";

pub(crate) const SCHEMA: &str = "
    CREATE TABLE outside_outcomes (
        from_host TEXT NOT NULL,
        key TEXT NOT NULL,
        outcome TEXT NOT NULL,
        ended_ms INTEGER NOT NULL,
        PRIMARY KEY (from_host, key)
    ) WITHOUT ROWID;
";

impl Store {
    /// How outside call `key` of `from_host` ended, as first recorded (JSON), if it did.
    pub fn outside_outcome(&self, from_host: &str, key: &str) -> Result<Option<String>> {
        Ok(self
            .lock()?
            .query_row(
                "SELECT outcome FROM outside_outcomes WHERE from_host = ?1 AND key = ?2",
                params![from_host, key],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Records how outside call `key` of `from_host` ended, once: the first outcome stays.
    /// Answers the one that stays.
    pub fn end_outside(
        &self,
        from_host: &str,
        key: &str,
        outcome: &str,
        now_ms: i64,
    ) -> Result<String> {
        let connection = self.lock()?;
        connection.execute(
            "INSERT OR IGNORE INTO outside_outcomes (from_host, key, outcome, ended_ms)
             VALUES (?1, ?2, ?3, ?4)",
            params![from_host, key, outcome, now_ms],
        )?;
        Ok(connection.query_row(
            "SELECT outcome FROM outside_outcomes WHERE from_host = ?1 AND key = ?2",
            params![from_host, key],
            |row| row.get(0),
        )?)
    }

    /// Forgets outside calls that ended before `before_ms`, their inbox rows with them. An open
    /// call is never forgotten.
    pub fn prune_outside(&self, before_ms: i64) -> Result<usize> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        tx.execute(
            &format!(
                "DELETE FROM inbox WHERE {OUTSIDE_LIKE} AND EXISTS (
                     SELECT 1 FROM outside_outcomes o
                     WHERE o.from_host = inbox.from_host AND o.key = inbox.key
                     AND o.ended_ms < ?1)"
            ),
            params![before_ms],
        )?;
        let gone = tx.execute(
            "DELETE FROM outside_outcomes WHERE ended_ms < ?1",
            params![before_ms],
        )?;
        tx.commit()?;
        Ok(gone)
    }
}
