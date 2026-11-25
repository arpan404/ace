// SPDX-License-Identifier: Apache-2.0
//! The durable queue metadata (`queue-store.ts:104`-`:240`, `:307`-`:459`). E5.4a's two
//! deliberate differences from TypeScript: a thread with no `engine_queue` row reads the
//! settings defaults with its pending count from `intents`, and every writer `ensure`s the row
//! first. Pending work is never read from the row.

use ace_json::Value as Json;
use ace_store::{Value, stmt_cache};
use std::sync::Arc;

use super::record::{RecoveryPatch, RecoveryRecord};
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
const UNCERTAIN: &str = "UPDATE intents SET uncertain=? WHERE id=?";
const PRUNE: &str = "DELETE FROM engine_queue_attachments WHERE intent_id=? AND EXISTS(SELECT 1 FROM intents WHERE id=? AND status IN ('done','failed') AND awaiting=0 AND uncertain=0)";
const NEXT_DEADLINE: &str = "SELECT resume_at FROM engine_queue WHERE resume_at IS NOT NULL AND thread_id IN (SELECT thread_id FROM thread_state)\n      ORDER BY resume_at LIMIT 1";
const LIMITED: &str = "SELECT thread_id FROM engine_queue WHERE limited=1 AND paused=1 AND reason='limit'\n      AND thread_id IN (SELECT thread_id FROM thread_state) LIMIT 256";
const DUE: &str = "SELECT thread_id FROM engine_queue WHERE resume_at<=? AND thread_id IN (SELECT thread_id FROM thread_state)\n      ORDER BY resume_at LIMIT 64";
const DEADLINE_KEY: &str = "SELECT resume_at,hold_token FROM engine_queue WHERE thread_id=? AND resume_at IS NOT NULL\n      AND thread_id IN (SELECT thread_id FROM thread_state)";

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
    Ok(RecoveryRecord {
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
    })
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
        tx.append_events(&ace_json::to_string(&Json::Array(events.into())))?;
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

/// `retains` (`:337`), with E5.4a's fallback for a home whose `queue-attachments` pass has not
/// run: the thread's live intents' payloads are checked too, bounded by its live intents.
pub fn retains(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    hash: &str,
) -> Result<bool, EngineError> {
    const ROWS: &str = "SELECT 1 FROM engine_queue_attachments a JOIN intents i ON i.id=a.intent_id WHERE a.thread_id=? AND a.hash=? AND (i.status IN ('pending','queued','running') OR i.awaiting=1 OR i.uncertain=1) LIMIT 1";
    if stmt_cache::get_row(
        conn,
        ROWS,
        vec![Value::Text(thread.to_owned()), Value::Text(hash.to_owned())],
    )?
    .is_some()
    {
        return Ok(true);
    }
    const PAYLOADS: &str = "SELECT payload FROM intents WHERE thread_id=? AND (status IN ('pending','queued','running') OR awaiting=1 OR uncertain=1)";
    let rows = stmt_cache::all_rows(conn, PAYLOADS, vec![Value::Text(thread.to_owned())])?;
    Ok(rows.iter().any(|row| {
        row.get("payload")
            .and_then(cell_text)
            .and_then(|text| ace_json::parse(text).ok())
            .is_some_and(|command| payload_retains(&command, hash))
    }))
}

fn payload_retains(command: &Json, hash: &str) -> bool {
    let attachments = command
        .get("payload")
        .and_then(|payload| payload.get("context"))
        .and_then(|context| context.get("attachments"));
    match attachments {
        Some(Json::Array(items)) => items
            .iter()
            .any(|item| item.get("sha256").and_then(Json::as_str) == Some(hash)),
        _ => false,
    }
}

/// `track` (`:344`): the intent's attachments, each hash once.
pub fn track(
    conn: &Arc<ace_store::Connection>,
    intent: u32,
    thread: &str,
    command: &Json,
) -> Result<(), EngineError> {
    const DELETE: &str = "DELETE FROM engine_queue_attachments WHERE intent_id=?";
    const INSERT: &str = "INSERT INTO engine_queue_attachments VALUES (?,?,?)";
    stmt_cache::run(conn, DELETE, vec![Value::Integer(i64::from(intent))])?;
    let payload = command.get("payload");
    let kind = payload
        .and_then(|payload| payload.get("type"))
        .and_then(Json::as_str);
    if !matches!(kind, Some("thread.create") | Some("thread.send")) {
        return Ok(());
    }
    let mut seen: Vec<String> = Vec::new();
    let attachments = payload
        .and_then(|payload| payload.get("context"))
        .and_then(|context| context.get("attachments"));
    if let Some(Json::Array(items)) = attachments {
        for item in items.iter() {
            let Some(hash) = item.get("sha256").and_then(Json::as_str) else {
                continue;
            };
            if seen.iter().any(|existing| existing == hash) {
                continue;
            }
            seen.push(hash.to_owned());
            stmt_cache::run(
                conn,
                INSERT,
                vec![
                    Value::Integer(i64::from(intent)),
                    Value::Text(thread.to_owned()),
                    Value::Text(hash.to_owned()),
                ],
            )?;
        }
    }
    Ok(())
}

/// `prune` (`:351`).
pub fn prune(conn: &Arc<ace_store::Connection>, intent: u32) -> Result<(), EngineError> {
    stmt_cache::run(
        conn,
        PRUNE,
        vec![
            Value::Integer(i64::from(intent)),
            Value::Integer(i64::from(intent)),
        ],
    )?;
    Ok(())
}

/// `edit` (`:356`).
pub fn edit(
    conn: &Arc<ace_store::Connection>,
    intent: u32,
    command: &Json,
    thread: &str,
) -> Result<(), EngineError> {
    const SQL: &str = "UPDATE intents SET payload=?,delivery=? WHERE id=?";
    let delivery = command
        .get("payload")
        .filter(|payload| payload.get("type").and_then(Json::as_str) == Some("thread.send"))
        .and_then(|payload| payload.get("delivery"))
        .and_then(Json::as_str)
        .unwrap_or("queue");
    stmt_cache::run(
        conn,
        SQL,
        vec![
            Value::Text(ace_json::to_string(command)),
            Value::Text(delivery.to_owned()),
            Value::Integer(i64::from(intent)),
        ],
    )?;
    track(conn, intent, thread, command)
}

/// `remove` (`:365`).
pub fn remove(conn: &Arc<ace_store::Connection>, intent: u32) -> Result<(), EngineError> {
    const DELETE: &str = "DELETE FROM engine_queue_attachments WHERE intent_id=?";
    const SQL: &str = "UPDATE intents SET status='failed',uncertain=0,awaiting=0,error='Removed from queue' WHERE id=?";
    stmt_cache::run(conn, DELETE, vec![Value::Integer(i64::from(intent))])?;
    stmt_cache::run(conn, SQL, vec![Value::Integer(i64::from(intent))])?;
    Ok(())
}

/// `move` (`:371`).
pub fn move_message(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    message: u32,
    after: Option<u32>,
) -> Result<bool, EngineError> {
    const ROWS: &str = "SELECT id FROM intents WHERE thread_id=? AND (trigger IS NULL OR trigger != 'subagent_result') AND kind IN ('thread.send','thread.create') AND status IN ('pending','queued') ORDER BY position,id LIMIT 256";
    const UPDATE: &str = "UPDATE intents SET position=? WHERE id=?";
    let rows: Vec<u32> = stmt_cache::all_rows(conn, ROWS, vec![Value::Text(thread.to_owned())])?
        .iter()
        .filter_map(|row| row.get("id").and_then(cell_int).map(|id| id as u32))
        .collect();
    if !rows.contains(&message)
        || Some(message) == after
        || after.is_some_and(|after| !rows.contains(&after))
    {
        return Ok(false);
    }
    let mut ordered: Vec<u32> = rows.into_iter().filter(|key| *key != message).collect();
    let at = match after {
        None => 0,
        Some(after) => ordered
            .iter()
            .position(|key| *key == after)
            .map(|position| position + 1)
            .unwrap_or(0),
    };
    ordered.insert(at, message);
    for (index, key) in ordered.iter().enumerate() {
        stmt_cache::run(
            conn,
            UPDATE,
            vec![
                Value::Integer(index as i64 + 1),
                Value::Integer(i64::from(*key)),
            ],
        )?;
    }
    Ok(true)
}

/// `reconcileUncertainty` (`:388`): only the ambiguity hold moves.
pub fn reconcile_uncertainty(
    store: &EngineStore,
    thread: &str,
    at: f64,
) -> Result<(), EngineError> {
    let value = get(store, thread)?;
    let patch =
        if value.reason.as_deref() == Some("uncertain") && !has_uncertain(store.conn(), thread)? {
            let reason = if value.limited {
                "limit"
            } else if value.continuation.is_some() {
                if value.trigger.as_deref() == Some("limit_resume") {
                    "limit"
                } else {
                    "restart"
                }
            } else {
                "manual"
            };
            format!("{{\"reason\":\"{reason}\",\"paused\":true}}")
        } else {
            "{}".to_owned()
        };
    set(store, thread, &patch, at)
}

/// `clearUncertain` (`:407`).
pub fn clear_uncertain(conn: &Arc<ace_store::Connection>, intent: u32) -> Result<(), EngineError> {
    stmt_cache::run(
        conn,
        UNCERTAIN,
        vec![Value::Integer(0), Value::Integer(i64::from(intent))],
    )?;
    Ok(())
}

/// `uncertain` (`:410`).
pub fn uncertain(conn: &Arc<ace_store::Connection>, intent: u32) -> Result<(), EngineError> {
    stmt_cache::run(
        conn,
        UNCERTAIN,
        vec![Value::Integer(1), Value::Integer(i64::from(intent))],
    )?;
    Ok(())
}

/// `nextDeadline` (`:417`).
pub fn next_deadline(conn: &Arc<ace_store::Connection>) -> Result<Option<i64>, EngineError> {
    let row = stmt_cache::get_row(conn, NEXT_DEADLINE, Vec::new())?;
    Ok(row.and_then(|row| row.get("resume_at").and_then(cell_int)))
}

/// `limited` (`:425`).
pub fn limited(conn: &Arc<ace_store::Connection>) -> Result<Vec<String>, EngineError> {
    let rows = stmt_cache::all_rows(conn, LIMITED, Vec::new())?;
    Ok(rows
        .iter()
        .filter_map(|row| row.get("thread_id").and_then(cell_text).map(str::to_owned))
        .collect())
}

/// `due` (`:433`).
pub fn due(conn: &Arc<ace_store::Connection>, now: i64) -> Result<Vec<String>, EngineError> {
    let rows = stmt_cache::all_rows(conn, DUE, vec![Value::Integer(now)])?;
    Ok(rows
        .iter()
        .filter_map(|row| row.get("thread_id").and_then(cell_text).map(str::to_owned))
        .collect())
}

/// `deadlineKey` (`:445`).
pub fn deadline_key(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Option<String>, EngineError> {
    let row = stmt_cache::get_row(conn, DEADLINE_KEY, vec![Value::Text(thread.to_owned())])?;
    Ok(row.map(|row| {
        format!(
            "{}:{}",
            row.get("resume_at").and_then(cell_int).unwrap_or(0),
            row.get("hold_token").and_then(cell_int).unwrap_or(0)
        )
    }))
}

/// `defer` (`:453`).
pub fn defer(conn: &Arc<ace_store::Connection>, thread: &str, at: i64) -> Result<(), EngineError> {
    const SQL: &str =
        "UPDATE engine_queue SET resume_at=? WHERE thread_id=? AND resume_at IS NOT NULL";
    ensure(conn, thread)?;
    stmt_cache::run(
        conn,
        SQL,
        vec![Value::Integer(at), Value::Text(thread.to_owned())],
    )?;
    Ok(())
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
