// SPDX-License-Identifier: Apache-2.0
//! The durable queue metadata (`queue-store.ts:104`-`:240`, `:307`-`:459`). E5.4a's two
//! deliberate differences from TypeScript: a thread with no `engine_queue` row reads the
//! settings defaults with its pending count from `intents`, and every writer `ensure`s the row
//! first. Pending work is never read from the row.

use ace_store::{Value, stmt_cache};
use std::sync::Arc;

use super::record::RecoveryRecord;
use crate::repository::residency::{cell_int, cell_text};
use crate::{EngineError, EngineStore};

const SELECT_ROW: &str = "SELECT * FROM engine_queue WHERE thread_id=?";
const HOLD: &str = "SELECT paused, reason FROM engine_queue WHERE thread_id=?";
const ENSURE: &str = "INSERT OR IGNORE INTO engine_queue(thread_id) VALUES (?)";
const COUNT: &str = "SELECT COUNT(*) AS n FROM intents WHERE thread_id=? AND (trigger IS NULL OR trigger != 'subagent_result') AND ((kind IN ('thread.send','thread.create') AND status IN ('pending','queued')) OR (kind IN ('thread.send','thread.create','thread.resume','queue.resume','thread.limit') AND uncertain=1))";
const WAITING: &str = "SELECT COUNT(*) AS n FROM intents WHERE thread_id=? AND ((kind IN ('thread.send','thread.create') AND status IN ('pending','queued')) OR (kind IN ('thread.send','thread.create','thread.resume','queue.resume','thread.limit') AND uncertain=1))";
const UNCERTAIN_RECOVERY: &str = "SELECT 1 FROM intents WHERE thread_id=? AND kind IN ('thread.resume','queue.resume','thread.limit') AND uncertain=1 LIMIT 1";
const HAS_UNCERTAIN: &str = "SELECT 1 FROM intents WHERE thread_id=? AND uncertain=1 LIMIT 1";
const POSITION: &str = "SELECT COALESCE(MAX(position),0)+1 AS n FROM intents WHERE thread_id=? AND (status IN ('pending','queued','running') OR uncertain=1)";

/// `ensure` (`:104`).
pub fn ensure(conn: &Arc<ace_store::Connection>, thread: &str) -> Result<(), EngineError> {
    stmt_cache::run(conn, ENSURE, vec![Value::Text(thread.to_owned())])?;
    Ok(())
}

/// `heldOnFailedSend` (`:108`).
pub fn held_on_failed_send(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<bool, EngineError> {
    let row = stmt_cache::get_row(conn, HOLD, vec![Value::Text(thread.to_owned())])?;
    Ok(row.is_some_and(|row| {
        row.get("paused").and_then(cell_int) == Some(1)
            && matches!(
                row.get("reason").and_then(cell_text),
                Some("not_sent") | Some("model_unavailable")
            )
    }))
}

/// `stoppedByPerson` (`:113`).
pub fn stopped_by_person(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<bool, EngineError> {
    let row = stmt_cache::get_row(conn, HOLD, vec![Value::Text(thread.to_owned())])?;
    Ok(row.is_some_and(|row| {
        row.get("paused").and_then(cell_int) == Some(1)
            && row.get("reason").and_then(cell_text) == Some("stopped")
    }))
}

/// `count` (`:186`): the person's queue; daemon-owned child results never count.
pub fn count(conn: &Arc<ace_store::Connection>, thread: &str) -> Result<i64, EngineError> {
    let row = stmt_cache::get_row(conn, COUNT, vec![Value::Text(thread.to_owned())])?;
    Ok(row
        .and_then(|row| row.get("n").and_then(cell_int))
        .unwrap_or(0))
}

/// `waitingSends` (`:196`): the person's queue and ace's child results.
pub fn waiting_sends(conn: &Arc<ace_store::Connection>, thread: &str) -> Result<i64, EngineError> {
    let row = stmt_cache::get_row(conn, WAITING, vec![Value::Text(thread.to_owned())])?;
    Ok(row
        .and_then(|row| row.get("n").and_then(cell_int))
        .unwrap_or(0))
}

/// `uncertainRecovery` (`:203`).
pub fn uncertain_recovery(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<bool, EngineError> {
    Ok(stmt_cache::get_row(
        conn,
        UNCERTAIN_RECOVERY,
        vec![Value::Text(thread.to_owned())],
    )?
    .is_some())
}

/// `hasUncertain` (`:237`).
pub fn has_uncertain(conn: &Arc<ace_store::Connection>, thread: &str) -> Result<bool, EngineError> {
    Ok(stmt_cache::get_row(conn, HAS_UNCERTAIN, vec![Value::Text(thread.to_owned())])?.is_some())
}

/// `get` (`:117`), with E5.4a's fix: no row reads the defaults, and the pending count still
/// comes from the thread's intents.
pub fn get(store: &EngineStore, thread: &str) -> Result<RecoveryRecord, EngineError> {
    let conn = store.conn();
    let pending = count(conn, thread)?;
    let Some(row) = stmt_cache::get_row(conn, SELECT_ROW, vec![Value::Text(thread.to_owned())])?
    else {
        return Ok(RecoveryRecord::defaults(pending));
    };
    let continuation = row
        .get("continuation")
        .and_then(cell_text)
        .map(str::to_owned);
    let uncertain_recovery = uncertain_recovery(conn, thread)?;
    let record = RecoveryRecord {
        pending_count: pending
            + i64::from(
                continuation.as_deref().is_some_and(|text| !text.is_empty()) && !uncertain_recovery,
            ),
        revision: row.get("revision").and_then(cell_int).unwrap_or(0),
        paused: row.get("paused").and_then(cell_int) == Some(1),
        last_failure: match row.get("last_failure").and_then(cell_text) {
            None => None,
            Some(text) => Some(
                ace_json::parse(text)
                    .map_err(|_| EngineError::Records("Invalid queue metadata".into()))?,
            ),
        },
        reason: row.get("reason").and_then(cell_text).map(str::to_owned),
        resume_at: row.get("resume_at").and_then(cell_int),
        exited: row.get("exited").and_then(cell_int) == Some(1),
        hold_token: row.get("hold_token").and_then(cell_int).unwrap_or(0),
        limited: row.get("limited").and_then(cell_int) == Some(1),
        reset_at: row.get("reset_at").and_then(cell_int),
        timer_action: row
            .get("timer_action")
            .and_then(cell_text)
            .map(str::to_owned),
        continuation,
        trigger: row.get("trigger").and_then(cell_text).map(str::to_owned),
    };
    record.validate()?;
    Ok(record)
}

/// `shown` (`:137`).
pub fn shown(store: &EngineStore, thread: &str) -> Result<RecoveryRecord, EngineError> {
    Ok(get(store, thread)?.shown())
}

/// `position` (`:313`).
pub fn position(conn: &Arc<ace_store::Connection>, thread: &str) -> Result<i64, EngineError> {
    let row = stmt_cache::get_row(conn, POSITION, vec![Value::Text(thread.to_owned())])?;
    Ok(row
        .and_then(|row| row.get("n").and_then(cell_int))
        .unwrap_or(1))
}

#[cfg(test)]
mod read_tests {
    use super::*;
    use crate::repository::testsupport::{Shell, header, home};

    fn row(
        conn: &Arc<ace_store::Connection>,
        thread: &str,
        continuation: &str,
        failure: Option<&str>,
    ) {
        conn.exec(&format!(
            "INSERT INTO engine_queue (thread_id,continuation,last_failure) VALUES ('{thread}', '{}', {})",
            continuation.replace('\'', "''"),
            failure.map_or("NULL".to_owned(), |value| format!("'{}'", value.replace('\'', "''")))
        ))
        .unwrap();
    }

    #[test]
    fn an_empty_continuation_adds_no_phantom_message() {
        let conn = home("queue-empty", &header("queue-empty"));
        row(&conn, "queue-empty", "", None);
        let record = get(&Shell::store(&conn), "queue-empty").unwrap();
        // The count is the intents' (none), and an empty string is falsy in TS.
        assert_eq!(record.pending_count, 0);
    }

    #[test]
    fn a_malformed_or_invalid_last_failure_is_refused() {
        for (thread, failure) in [
            ("queue-bad-json", "{not json"),
            ("queue-bad-object", "{\"title\":\"\",\"code\":\"x\"}"),
            ("queue-bad-code", "{\"title\":\"Failed\",\"code\":\"\"}"),
        ] {
            let conn = home(thread, &header(thread));
            row(&conn, thread, "", Some(failure));
            assert!(
                get(&Shell::store(&conn), thread).is_err(),
                "{failure} must be refused"
            );
        }
        // A valid one is kept whole.
        let conn = home("queue-good", &header("queue-good"));
        row(
            &conn,
            "queue-good",
            "",
            Some("{\"title\":\"Failed\",\"code\":\"delivery_failed\"}"),
        );
        let record = get(&Shell::store(&conn), "queue-good").unwrap();
        assert_eq!(
            record
                .last_failure
                .as_ref()
                .and_then(|value| value.get("code"))
                .and_then(ace_json::Value::as_str),
            Some("delivery_failed")
        );
    }

    #[test]
    fn a_patch_revision_is_merged_then_incremented_once() {
        let conn = home("queue-revision", &header("queue-revision"));
        let store = Shell::store(&conn);
        crate::queue::write::set(&store, "queue-revision", "{\"revision\":5}", 1.0).unwrap();
        // The patch's 5 is the revision the bump counts from.
        assert_eq!(get(&store, "queue-revision").unwrap().revision, 6);
        crate::queue::write::set(&store, "queue-revision", "{}", 2.0).unwrap();
        assert_eq!(get(&store, "queue-revision").unwrap().revision, 7);
    }
}
