//! What each bot spent, for its caps (ADR 0135), and where its oversight settings are kept. The
//! settings themselves are JSON in the `settings` table, shaped by the server.

use std::collections::HashMap;

use rusqlite::params;

use crate::{Result, Store};

/// The service-wide oversight settings' key.
pub const OVERSIGHT: &str = "oversight";

/// One bot's oversight settings' key.
pub fn agent_key(agent: &str) -> String {
    format!("oversight:{agent}")
}

/// A conversation's spend since the start of the day and of the month.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AgentSpend {
    pub today_micros: u64,
    pub month_micros: u64,
}

impl Store {
    /// What `conversation` spent from `since_ms` on.
    pub fn spent_by(&self, conversation: &str, since_ms: i64) -> Result<u64> {
        let total: i64 = self.lock()?.query_row(
            "SELECT COALESCE(SUM(cost_micros), 0) FROM spend
             WHERE at_ms >= ?2 AND conversation_id = ?1",
            params![conversation, since_ms],
            |row| row.get(0),
        )?;
        Ok(u64::try_from(total).unwrap_or(0))
    }

    /// Every conversation's spend since `day_start` and since `month_start` (the earlier), in one
    /// read of the month's rows.
    pub fn spend_by_conversation(
        &self,
        day_start: i64,
        month_start: i64,
    ) -> Result<HashMap<String, AgentSpend>> {
        let from = day_start.min(month_start);
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT conversation_id,
                    COALESCE(SUM(CASE WHEN at_ms >= ?1 THEN cost_micros ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN at_ms >= ?2 THEN cost_micros ELSE 0 END), 0)
             FROM spend WHERE at_ms >= ?3 GROUP BY conversation_id",
        )?;
        let rows = statement.query_map(params![day_start, month_start, from], |row| {
            let today: i64 = row.get(1)?;
            let month: i64 = row.get(2)?;
            Ok((
                row.get::<_, String>(0)?,
                AgentSpend {
                    today_micros: u64::try_from(today).unwrap_or(0),
                    month_micros: u64::try_from(month).unwrap_or(0),
                },
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<HashMap<_, _>>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_conversation_spends_its_own_day_and_month() -> Result<()> {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("temp dir: {e}"));
        let store = Store::open(&dir.path().join("s.sqlite"))?;
        store.record_spend("a", "m", 100, 50)?; // before the month
        store.record_spend("a", "m", 200, 150)?; // this month, before today
        store.record_spend("a", "m", 300, 250)?; // today
        store.record_spend("b", "m", 7, 260)?;
        let spend = store.spend_by_conversation(200, 100)?;
        assert_eq!(
            spend.get("a"),
            Some(&AgentSpend {
                today_micros: 300,
                month_micros: 500
            })
        );
        assert_eq!(spend.get("b").map(|s| s.today_micros), Some(7));
        assert_eq!(store.spent_by("a", 200)?, 300);
        assert_eq!(store.spent_by("b", 0)?, 7);
        Ok(())
    }
}
