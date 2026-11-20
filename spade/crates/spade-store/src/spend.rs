//! What each call was for (ADR 0162): the ledger records a role with each cost, so the person
//! sees what a bot's helpers, checks, reviews, summaries and titles spent apart from its turns.

use std::collections::BTreeMap;

use rusqlite::params;

use crate::{Result, Store};

/// The schema step that adds the role. Rows from before it were the bot's own turns, or could
/// not be told apart: they count as `main`.
pub(crate) const SCHEMA: &str = "ALTER TABLE spend ADD COLUMN role TEXT NOT NULL DEFAULT 'main';";

/// The service-wide model roles' settings key.
pub const MODEL_ROLES: &str = "model_roles";

/// One bot's model roles' settings key.
pub fn roles_key(agent: &str) -> String {
    format!("{MODEL_ROLES}:{agent}")
}

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
        let connection = self.lock()?;
        if crate::gate::arriving(&connection, crate::gate::CONVERSATION, conversation)? {
            return Err(crate::StoreError::NoConversation(conversation.to_owned()));
        }
        connection.execute(
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
        let mut statement = connection.prepare(&format!(
            "SELECT role, COALESCE(SUM(cost_micros), 0) FROM spend
             WHERE at_ms >= ?2 AND conversation_id = ?1
               AND conversation_id NOT IN {} GROUP BY role",
            crate::gate::ARRIVING_CONVERSATIONS
        ))?;
        let rows = statement.query_map(params![conversation, since_ms], |row| {
            let total: i64 = row.get(1)?;
            Ok((row.get::<_, String>(0)?, u64::try_from(total).unwrap_or(0)))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// What `conversation` spent in each of the `hours` hours before `to_ms`, oldest first: the
    /// last entry is `[to_ms - 1h, to_ms)`. One read of the window's rows (ADR 0195).
    pub fn spent_by_hour(&self, conversation: &str, to_ms: i64, hours: usize) -> Result<Vec<u64>> {
        const HOUR_MS: i64 = 3_600_000;
        let count = i64::try_from(hours).unwrap_or(0);
        let from_ms = to_ms - count * HOUR_MS;
        let connection = self.lock()?;
        let mut statement = connection.prepare(&format!(
            "SELECT (?3 - 1 - at_ms) / {HOUR_MS}, COALESCE(SUM(cost_micros), 0) FROM spend
             WHERE conversation_id = ?1 AND at_ms >= ?2 AND at_ms < ?3
             AND conversation_id NOT IN {}
             GROUP BY 1",
            crate::gate::ARRIVING_CONVERSATIONS
        ))?;
        let mut by_hour = vec![0_u64; hours];
        let rows = statement.query_map(params![conversation, from_ms, to_ms], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (ago, spent) = row?;
            if let Ok(ago) = usize::try_from(ago)
                && ago < hours
            {
                by_hour[hours - 1 - ago] = u64::try_from(spent).unwrap_or(0);
            }
        }
        Ok(by_hour)
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
        // The bot's total still counts every role.
        assert_eq!(store.spent_by("a", 0)?, 1_550);
        Ok(())
    }

    #[test]
    fn spend_reads_by_the_hour_before_a_time_oldest_first() -> Result<()> {
        const HOUR: i64 = 3_600_000;
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("temp dir: {e}"));
        let store = Store::open(&dir.path().join("spade.sqlite"))?;
        let to = 10 * HOUR;
        store.record_spend("a", "m", 5, to - 1)?;
        store.record_spend("a", "m", 7, to - HOUR + 1)?;
        store.record_spend("a", "m", 11, to - HOUR - 1)?;
        store.record_spend("a", "m", 13, to - 3 * HOUR)?;
        store.record_spend("a", "m", 99, to)?;
        store.record_spend("a", "m", 99, to - 4 * HOUR)?;
        store.record_spend("b", "m", 99, to - 1)?;
        assert_eq!(store.spent_by_hour("a", to, 3)?, vec![13, 11, 12]);
        Ok(())
    }
}
