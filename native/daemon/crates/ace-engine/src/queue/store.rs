// SPDX-License-Identifier: Apache-2.0
//! The durable queue metadata (`queue-store.ts:104`-`:240`, `:307`-`:459`). E5.4a's two
//! deliberate differences from TypeScript: a thread with no `engine_queue` row reads the
//! settings defaults with its pending count from `intents`, and every writer `ensure`s the row
//! first. Pending work is never read from the row.

use ace_json::Value as Json;
use ace_store::{Value, stmt_cache};
use std::sync::Arc;

use super::patch::RecoveryPatch;
use super::record::RecoveryRecord;
use super::wake;
use crate::repository::residency::{cell_int, cell_text};
use crate::{EngineError, EngineStore};

const SELECT_ROW: &str = "SELECT * FROM engine_queue WHERE thread_id=?";
const ENSURE: &str = "INSERT OR IGNORE INTO engine_queue(thread_id) VALUES (?)";
const UPDATE: &str = "UPDATE engine_queue SET revision=?,paused=?,reason=?,limited=?,reset_at=?,resume_at=?,timer_action=?,continuation=?,trigger=?,hold_token=?,last_failure=?,exited=? WHERE thread_id=?";
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
    let row = stmt_cache::get_row(conn, SELECT_ROW, vec![Value::Text(thread.to_owned())])?;
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
    let row = stmt_cache::get_row(conn, SELECT_ROW, vec![Value::Text(thread.to_owned())])?;
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
        pending_count: pending + i64::from(continuation.is_some() && !uncertain_recovery),
        revision: row.get("revision").and_then(cell_int).unwrap_or(0),
        paused: row.get("paused").and_then(cell_int) == Some(1),
        last_failure: row
            .get("last_failure")
            .and_then(cell_text)
            .and_then(|text| ace_json::parse(text).ok()),
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

/// `set` (`:141`): one revision bump and one `appendEvents`, the snooze wake first.
pub fn set(store: &EngineStore, thread: &str, patch: &str, at: f64) -> Result<(), EngineError> {
    store.atomic(|tx| {
        let before = get(store, thread)?;
        let mut value = RecoveryPatch::parse(patch)?.apply(&before)?;
        value.revision = before.revision + 1;
        ensure(tx.conn(), thread)?;
        let pending = count(tx.conn(), thread)?
            + i64::from(value.continuation.is_some() && !uncertain_recovery(tx.conn(), thread)?);
        value.pending_count = pending;
        stmt_cache::run(
            tx.conn(),
            UPDATE,
            vec![
                Value::Integer(value.revision),
                Value::Integer(i64::from(value.paused)),
                value.reason.clone().map_or(Value::Null, Value::Text),
                Value::Integer(i64::from(value.limited)),
                value.reset_at.map_or(Value::Null, Value::Integer),
                value.resume_at.map_or(Value::Null, Value::Integer),
                value.timer_action.clone().map_or(Value::Null, Value::Text),
                value.continuation.clone().map_or(Value::Null, Value::Text),
                value.trigger.clone().map_or(Value::Null, Value::Text),
                Value::Integer(value.hold_token),
                value.last_failure.as_ref().map_or(Value::Null, |failure| {
                    Value::Text(ace_json::to_string(failure))
                }),
                Value::Integer(i64::from(value.exited)),
                Value::Text(thread.to_owned()),
            ],
        )?;
        let queue = value.to_json();
        let mut events = wake::wake_for(store, thread, &queue, at)?;
        let updated = match queue {
            Json::Object(map) => map,
            _ => return Err(EngineError::Records("Invalid queue metadata".into())),
        };
        let mut ordered = ace_json::Map::new();
        ordered.insert("type", Json::from("queue.updated"));
        for (key, item) in updated {
            ordered.insert(key, item);
        }
        events.push(Json::Object(ordered));
        store.write_events(
            thread,
            &ace_json::to_string(&Json::Array(events.into())),
            at,
        )?;
        Ok(())
    })
}

/// `position` (`:313`).
pub fn position(conn: &Arc<ace_store::Connection>, thread: &str) -> Result<i64, EngineError> {
    let row = stmt_cache::get_row(conn, POSITION, vec![Value::Text(thread.to_owned())])?;
    Ok(row
        .and_then(|row| row.get("n").and_then(cell_int))
        .unwrap_or(1))
}

/// `reconcileUncertainty` (`:388`): only the ambiguity hold moves.
pub fn reconcile_uncertainty(
    store: &EngineStore,
    thread: &str,
    at: f64,
) -> Result<(), EngineError> {
    let value = get(store, thread)?;
    let patch = match reconciled_reason(&value, has_uncertain(store.conn(), thread)?) {
        Some(reason) => format!("{{\"reason\":\"{reason}\",\"paused\":true}}"),
        None => "{}".to_owned(),
    };
    set(store, thread, &patch, at)
}

/// The reason only an ambiguity hold moves to, or none when it is not the one held.
fn reconciled_reason(value: &RecoveryRecord, has_uncertain: bool) -> Option<&'static str> {
    if value.reason.as_deref() != Some("uncertain") || has_uncertain {
        return None;
    }
    Some(if value.limited {
        "limit"
    } else if value.continuation.is_some() {
        if value.trigger.as_deref() == Some("limit_resume") {
            "limit"
        } else {
            "restart"
        }
    } else {
        "manual"
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::Shell;
    use crate::repository::testsupport::{header, home, sql_text};

    fn send(command: &str, text: &str) -> String {
        format!(
            r#"{{"id":"{command}","deviceId":"device","payload":{{"type":"thread.send","threadId":"noqueue","input":[{{"type":"text","text":"{text}"}}]}}}}"#
        )
    }

    #[test]
    fn a_thread_with_no_queue_row_reads_the_defaults_and_its_pending_sends() {
        // The intended difference from TypeScript: the pending work is in `intents`, the row
        // only holds settings, so a missing row must not hide or fail the queue.
        let conn = home("noqueue", &header("noqueue"));
        conn.exec("DELETE FROM engine_queue").unwrap();
        for (position, (command, text)) in [("a", "one"), ("b", "two")].into_iter().enumerate() {
            conn.exec(&format!(
                "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position) \
                 VALUES ({}, 'noqueue', 'thread.send', {}, 'pending', 'queue', {})",
                sql_text(command),
                sql_text(&send(command, text)),
                position + 1
            ))
            .unwrap();
        }
        let store = Shell::store(&conn);
        let record = get(&store, "noqueue").unwrap();
        assert_eq!(record.pending_count, 2);
        assert_eq!(record.revision, 0);
        assert!(!record.paused && !record.limited && !record.exited);
        assert_eq!(record.hold_token, 0);
        assert!(record.continuation.is_none() && record.trigger.is_none());
        let snapshot = crate::queue::page::snapshot(&store, "noqueue").unwrap();
        assert_eq!(
            snapshot
                .get("pendingCount")
                .and_then(ace_json::Value::as_i64),
            Some(2)
        );
        assert_eq!(
            snapshot
                .get("messages")
                .and_then(ace_json::Value::as_array)
                .map(|messages| messages.len()),
            Some(2)
        );
        // And the thread still runs: `runnableThreads` keeps a thread with no queue row.
        assert_eq!(
            crate::intents::store::runnable_threads(store.conn(), 8).unwrap(),
            vec!["noqueue".to_owned()]
        );
    }
}

#[cfg(test)]
mod reconcile_tests {
    use super::*;

    fn held(limited: bool, continuation: Option<&str>, trigger: Option<&str>) -> RecoveryRecord {
        RecoveryRecord {
            paused: true,
            reason: Some("uncertain".into()),
            limited,
            continuation: continuation.map(str::to_owned),
            trigger: trigger.map(str::to_owned),
            ..RecoveryRecord::defaults(0)
        }
    }

    #[test]
    fn only_the_uncertainty_hold_moves_and_keeps_its_own_reason() {
        // A limit wins over a continuation; a continuation says why it is held; with neither
        // the hold becomes the person's. A hold another reason keeps, or one still ambiguous,
        // does not move.
        assert_eq!(
            reconciled_reason(&held(true, Some("go on"), Some("restart")), false),
            Some("limit")
        );
        assert_eq!(
            reconciled_reason(&held(false, Some("go on"), Some("limit_resume")), false),
            Some("limit")
        );
        assert_eq!(
            reconciled_reason(&held(false, Some("go on"), Some("restart")), false),
            Some("restart")
        );
        assert_eq!(
            reconciled_reason(&held(false, None, None), false),
            Some("manual")
        );
        assert_eq!(reconciled_reason(&held(true, None, None), true), None);
        let manual = RecoveryRecord {
            reason: Some("manual".into()),
            ..held(false, None, None)
        };
        assert_eq!(reconciled_reason(&manual, false), None);
    }
}
