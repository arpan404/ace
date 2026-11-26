// SPDX-License-Identifier: Apache-2.0
//! The queue's one write (`queue-store.ts:141`-`:184`): merge, bump the revision, update the
//! row, then publish the snooze wake and `queue.updated`. Split from the reads so a fold can
//! stage the row while its `State` borrow is held and write the events once it is released.

use ace_json::Value as Json;
use ace_store::{Value, stmt_cache};

use super::patch::RecoveryPatch;
use super::record::RecoveryRecord;
use super::store::{count, ensure, get, has_uncertain, uncertain_recovery};
use super::wake;
use crate::{EngineError, EngineStore};

const UPDATE: &str = "UPDATE engine_queue SET revision=?,paused=?,reason=?,limited=?,reset_at=?,resume_at=?,timer_action=?,continuation=?,trigger=?,hold_token=?,last_failure=?,exited=? WHERE thread_id=?";

/// One queue change the fold staged: its row is written already, its events are not.
#[derive(Debug, Clone)]
pub struct StagedEvent {
    pub thread: String,
    pub queue: Json,
    pub at: f64,
}

/// `set` (`queue-store.ts:141`): one revision bump and one `appendEvents`, the snooze wake first. Outside a
/// fold's borrow, both happen now.
pub fn set(store: &EngineStore, thread: &str, patch: &str, at: f64) -> Result<(), EngineError> {
    store.atomic(|_tx| {
        let staged = stage(store, thread, patch, at)?;
        finish(store, &staged)
    })
}

/// The row half of `set`: merge, bump, validate and update, with no port called, so a fold can
/// stage it while `State` is borrowed and write its events after the borrow is released.
pub fn stage(
    store: &EngineStore,
    thread: &str,
    patch: &str,
    at: f64,
) -> Result<StagedEvent, EngineError> {
    let before = get(store, thread)?;
    let mut value = RecoveryPatch::parse(patch)?.apply(&before)?;
    value.revision += 1;
    value.validate()?;
    ensure(store.conn(), thread)?;
    let pending = count(store.conn(), thread)?
        + i64::from(
            value
                .continuation
                .as_deref()
                .is_some_and(|text| !text.is_empty())
                && !uncertain_recovery(store.conn(), thread)?,
        );
    value.pending_count = pending;
    stmt_cache::run(
        store.conn(),
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
    Ok(StagedEvent {
        thread: thread.to_owned(),
        queue: value.to_json(),
        at,
    })
}

/// The event half of `set`, with no `State` borrow held: the snooze wake, then `queue.updated`,
/// in one event-writer call.
pub fn finish(store: &EngineStore, staged: &StagedEvent) -> Result<(), EngineError> {
    let mut events = wake::wake_for(store, &staged.thread, &staged.queue, staged.at)?;
    let updated = match staged.queue.clone() {
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
        &staged.thread,
        &ace_json::to_string(&Json::Array(events.into())),
        staged.at,
    )
}

/// `reconcileUncertainty` (`:388`): only the ambiguity hold moves.
pub fn reconcile_uncertainty(
    store: &EngineStore,
    thread: &str,
    at: f64,
) -> Result<StagedEvent, EngineError> {
    let value = get(store, thread)?;
    let patch = match reconciled_reason(&value, has_uncertain(store.conn(), thread)?) {
        Some(reason) => format!("{{\"reason\":\"{reason}\",\"paused\":true}}"),
        None => "{}".to_owned(),
    };
    stage(store, thread, &patch, at)
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
