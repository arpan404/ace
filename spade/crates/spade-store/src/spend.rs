//! What each call was for (ADR 0162): the ledger records a role with each cost, so the person
//! sees what a bot's helpers, checks, reviews, summaries and titles spent apart from its turns.

use std::collections::BTreeMap;

use rusqlite::params;

use crate::{Result, Store};

/// The schema step that adds the role. Rows from before it were the bot's own turns, or could
/// not be told apart: they count as `main`.
pub(crate) const SCHEMA: &str = "ALTER TABLE spend ADD COLUMN role TEXT NOT NULL DEFAULT 'main';";

impl Store {
    /// Records what a call for `role` cost.
    pub fn record_spend_as(
        &self,
        conversation: &str,
        model: &str,
        role: &str,
        cost_micros: u64,
        now_ms: i64,
    ) -> Result<()> {
        let cost = i64::try_from(cost_micros).unwrap_or(i64::MAX);
        self.lock()?.execute(
            "INSERT INTO spend (conversation_id, model, role, cost_micros, at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![conversation, model, role, cost, now_ms],
        )?;
        Ok(())
    }

    /// What `conversation` spent from `since_ms` on, by role.
    pub fn spent_by_role(
        &self,
        conversation: &str,
        since_ms: i64,
    ) -> Result<BTreeMap<String, u64>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT role, COALESCE(SUM(cost_micros), 0) FROM spend
             WHERE at_ms >= ?2 AND conversation_id = ?1 GROUP BY role",
        )?;
        let rows = statement.query_map(params![conversation, since_ms], |row| {
            let total: i64 = row.get(1)?;
            Ok((row.get::<_, String>(0)?, u64::try_from(total).unwrap_or(0)))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

#[cfg(test)]
mod tests {
    use crate::{Result, Store};

    #[test]
    fn spend_adds_up_by_role_from_the_given_time_and_plain_records_count_as_main() -> Result<()> {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("temp dir: {e}"));
        let store = Store::open(&dir.path().join("spade.sqlite"))?;
        store.record_spend("a", "e/strong", 1_000, 100)?;
        store.record_spend_as("a", "e/fast", "helper", 200, 150)?;
        store.record_spend_as("a", "e/fast", "helper", 300, 250)?;
        store.record_spend_as("a", "e/strong", "verify", 50, 260)?;
        store.record_spend_as("b", "e/fast", "title", 7, 260)?;
        let all = store.spent_by_role("a", 0)?;
        assert_eq!(
            all.into_iter().collect::<Vec<_>>(),
            [
                ("helper".into(), 500),
                ("main".into(), 1_000),
                ("verify".into(), 50)
            ]
        );
        let later = store.spent_by_role("a", 200)?;
        assert_eq!(later.get("helper"), Some(&300));
        assert_eq!(later.get("main"), None);
        // The caps still count every role.
        assert_eq!(store.spent_by("a", 0)?, 1_550);
        Ok(())
    }
}
