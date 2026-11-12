//! What each bot spent, for its caps (ADR 0135), and where its oversight settings are kept. The
//! settings themselves are JSON in the `settings` table, shaped by the server.

use std::collections::HashMap;

use rusqlite::params;
use spade_core::Event;

use crate::StoredEvent;

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

/// Event types the activity log reads (ADR 0135): the rest (progress checkpoints, indexes,
/// titles, compaction) never make an entry.
pub const ACTIVITY_TYPES: [&str; 17] = [
    "user_message",
    "reply_started",
    "step_finished",
    "approval_requested",
    "approval_answered",
    "tool_started",
    "tool_finished",
    "job_started",
    "job_finished",
    "call_reviewed",
    "cap_reached",
    "reply_finished",
    "reply_stopped",
    "reply_failed",
    "reply_interrupted",
    "question_asked",
    "stop_requested",
];

impl Store {
    /// The ends (`tool_finished`, `job_finished`) of the calls and jobs in `ids`, numbered from
    /// `from` up to `before`, oldest first: what a page of the activity log needs from above
    /// its cursor so a call started in it shows how it went.
    pub fn finishes(
        &self,
        conversation: &str,
        ids: &[String],
        from: i64,
        before: i64,
    ) -> Result<Vec<StoredEvent>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let wanted = serde_json::to_string(ids).unwrap_or_else(|_| "[]".to_owned());
        let raw: Vec<(i64, i64, String)> = {
            let connection = self.lock()?;
            let mut statement = connection.prepare_cached(
                "SELECT seq, at_ms, body FROM events
                 WHERE conversation_id = ?1 AND seq >= ?2 AND seq < ?3
                   AND ((json_extract(body, '$.type') = 'tool_finished'
                         AND json_extract(body, '$.call_id') IN (SELECT value FROM json_each(?4)))
                     OR (json_extract(body, '$.type') = 'job_finished'
                         AND json_extract(body, '$.job') IN (SELECT value FROM json_each(?4))))
                 ORDER BY seq",
            )?;
            let rows = statement.query_map(params![conversation, from, before, wanted], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        Ok(decode(raw))
    }

    /// The conversation's last event number, 0 when it has none.
    pub fn last_seq(&self, conversation: &str) -> Result<i64> {
        Ok(self.lock()?.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM events WHERE conversation_id = ?1",
            params![conversation],
            |row| row.get(0),
        )?)
    }

    /// The conversation's events numbered from `from` up to `before` (one window of the
    /// history), of the given `types` only, stored before `until_ms` when given, oldest first.
    /// SQLite does the filtering; a step's text and thoughts are emptied and a message's context and images
    /// are left out, since the log never shows them. The lock is held only while the window is
    /// read: the rows are decoded after it is released, so other bots' reads and writes wait at
    /// most one window.
    pub fn activity_window(
        &self,
        conversation: &str,
        from: i64,
        before: i64,
        types: &[&str],
        until_ms: Option<i64>,
    ) -> Result<Vec<StoredEvent>> {
        let wanted = serde_json::to_string(types).unwrap_or_else(|_| "[]".to_owned());
        let raw: Vec<(i64, i64, String)> = {
            let connection = self.lock()?;
            let mut statement = connection.prepare_cached(
                "SELECT seq, at_ms,
                        CASE json_extract(body, '$.type')
                          WHEN 'step_finished' THEN json_set(body, '$.text', '', '$.thoughts', json('[]'))
                          WHEN 'user_message' THEN json_remove(body, '$.context', '$.images')
                          ELSE body END
                 FROM events
                 WHERE conversation_id = ?1 AND seq >= ?2 AND seq < ?3
                   AND at_ms < ?5
                   AND json_extract(body, '$.type') IN (SELECT value FROM json_each(?4))
                   AND (json_extract(body, '$.type') != 'user_message'
                        OR json_extract(body, '$.from_agent') IS NOT NULL
                        OR json_extract(body, '$.from_routine') IS NOT NULL)
                 ORDER BY seq",
            )?;
            let rows = statement.query_map(
                params![
                    conversation,
                    from,
                    before,
                    wanted,
                    until_ms.unwrap_or(i64::MAX)
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        Ok(decode(raw))
    }
}

/// Rows as events, decoded after the database lock is let go.
fn decode(raw: Vec<(i64, i64, String)>) -> Vec<StoredEvent> {
    raw.into_iter()
        .map(|(seq, at_ms, body)| StoredEvent {
            seq,
            at_ms,
            event: Event::from_json(
                serde_json::from_str(&body).unwrap_or(serde_json::Value::String(body)),
            ),
        })
        .collect()
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
