// SPDX-License-Identifier: Apache-2.0
//! `IntentStore`'s reads (`intents.ts:92`-`:378`) and the repository's intent delegations
//! (`repository.ts:485`-`:664`). Every statement is the TypeScript's own text, cached per text
//! on the shared connection. E5.4a's two deliberate differences from TypeScript are here:
//! `runnableThreads` keeps a thread whose intents are pending with no `engine_queue` row, and
//! `headers` turns a row it cannot read into the `unreadable` callback instead of a throw.

use ace_store::{Value, stmt_cache};
use std::sync::Arc;

use super::header::{Intent, IntentHeader};
use crate::EngineError;
use crate::repository::residency::{cell_int, cell_text};

pub const DELIVERY_KINDS: &str =
    "'thread.create','thread.send','thread.fork','thread.switch','thread.merge'";

/// A command's place in the queue, as `delivery` reports it.
#[derive(Debug, Clone)]
pub struct DeliveryInfo {
    pub status: String,
    pub delivery: String,
    pub trigger: Option<String>,
    pub uncertain: bool,
    pub error: Option<String>,
}

pub(crate) fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(cell_text)
}

pub(crate) fn thread_value(thread: &str) -> Value {
    Value::Text(thread.to_owned())
}

/// `latestGeneration` (`intents.ts:92`).
pub fn latest_generation(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<i64, EngineError> {
    const SQL: &str =
        "SELECT COALESCE(MAX(submitted_generation),0) AS generation FROM intents WHERE thread_id=?";
    let row = stmt_cache::get_row(conn, SQL, vec![thread_value(thread)])?;
    Ok(row
        .and_then(|row| row.get("generation").and_then(cell_int))
        .unwrap_or(0))
}

/// `delivery` (`:104`).
pub fn delivery(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    command_id: &str,
) -> Result<Option<DeliveryInfo>, EngineError> {
    const SQL: &str = "SELECT status,uncertain,error,delivery,trigger FROM intents WHERE thread_id=? AND command_id=? LIMIT 1";
    let Some(row) = stmt_cache::get_row(
        conn,
        SQL,
        vec![thread_value(thread), Value::Text(command_id.to_owned())],
    )?
    else {
        return Ok(None);
    };
    let status = text(row.get("status"))
        .filter(|value| super::header::STATUSES.contains(value))
        .ok_or_else(|| EngineError::Records("Invalid intent header: status".into()))?;
    let delivery = text(row.get("delivery"))
        .filter(|value| super::header::DELIVERIES.contains(value))
        .ok_or_else(|| EngineError::Records("Invalid intent header: delivery".into()))?;
    Ok(Some(DeliveryInfo {
        status: status.to_owned(),
        delivery: delivery.to_owned(),
        trigger: text(row.get("trigger")).map(str::to_owned),
        uncertain: row.get("uncertain").and_then(cell_int) == Some(1),
        error: text(row.get("error")).map(str::to_owned),
    }))
}

/// `failure` (`:119`): why an admitted command failed after admission, if it did.
pub fn failure(
    conn: &Arc<ace_store::Connection>,
    command_id: &str,
) -> Result<Option<String>, EngineError> {
    const SQL: &str = "SELECT error FROM intents WHERE command_id=? AND status='failed' LIMIT 1";
    let row = stmt_cache::get_row(conn, SQL, vec![Value::Text(command_id.to_owned())])?;
    Ok(row.map(|row| {
        text(row.get("error"))
            .map(str::to_owned)
            .unwrap_or_else(|| "Not delivered".to_owned())
    }))
}

/// `commandStatus` (`:125`).
pub fn command_status(
    conn: &Arc<ace_store::Connection>,
    command_id: &str,
) -> Result<Option<String>, EngineError> {
    const SQL: &str = "SELECT status FROM intents WHERE command_id=? LIMIT 1";
    let row = stmt_cache::get_row(conn, SQL, vec![Value::Text(command_id.to_owned())])?;
    let Some(row) = row else {
        return Ok(None);
    };
    text(row.get("status"))
        .filter(|value| super::header::STATUSES.contains(value))
        .map(|value| Some(value.to_owned()))
        .ok_or_else(|| EngineError::Records("Invalid intent header: status".into()))
}

/// `recoveryAcknowledgement` (`:162`).
pub fn recovery_acknowledgement(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<bool, EngineError> {
    const SQL: &str = "SELECT 1 FROM intents i JOIN engine_state_records r ON r.thread_id=i.thread_id AND r.section='engineRecovery' AND r.key='root' AND i.id=CAST(r.value AS INTEGER) WHERE i.thread_id=? AND (i.acknowledged=1 OR i.uncertain=1 OR (i.awaiting=1 AND i.status<>'failed')) LIMIT 1";
    Ok(stmt_cache::get_row(conn, SQL, vec![thread_value(thread)])?.is_some())
}

/// `unconfirmedContinuation` (`:169`).
pub fn unconfirmed_continuation(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<bool, EngineError> {
    const SQL: &str = "SELECT 1 FROM intents WHERE thread_id=? AND acknowledged=0 AND submitted_generation IS NOT NULL AND (awaiting=1 OR uncertain=1) AND id=(SELECT CAST(value AS INTEGER) FROM engine_state_records WHERE thread_id=? AND section='engineRecovery' AND key='root') LIMIT 1";
    let id = thread_value(thread);
    Ok(stmt_cache::get_row(conn, SQL, vec![id.clone(), id])?.is_some())
}

/// `uncertainContinuation` (`:176`).
pub fn uncertain_continuation(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Option<IntentHeader>, EngineError> {
    const SQL: &str = "SELECT id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id FROM intents WHERE thread_id=? AND uncertain=1 AND id=(SELECT CAST(value AS INTEGER) FROM engine_state_records WHERE thread_id=? AND section='engineRecovery' AND key='root') LIMIT 1";
    let id = thread_value(thread);
    header_row(conn, SQL, vec![id.clone(), id])
}

/// `finishContinuation` (`:182`).
pub fn finish_continuation(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<(), EngineError> {
    const SQL: &str = "DELETE FROM engine_state_records WHERE thread_id=? AND section='engineRecovery' AND key='root'";
    stmt_cache::run(conn, SQL, vec![thread_value(thread)])?;
    Ok(())
}

/// `recovering` (`:187`).
pub fn recovering(conn: &Arc<ace_store::Connection>, thread: &str) -> Result<bool, EngineError> {
    if recovery_acknowledgement(conn, thread)? {
        return Ok(true);
    }
    const SQL: &str = "SELECT 1 FROM intents WHERE thread_id=? AND kind IN ('thread.resume','queue.resume','thread.limit') AND status IN ('pending','running') LIMIT 1";
    Ok(stmt_cache::get_row(conn, SQL, vec![thread_value(thread)])?.is_some())
}

/// `recovery` (`:197`).
pub fn recovery(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Option<IntentHeader>, EngineError> {
    const SQL: &str = "SELECT id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id FROM intents WHERE thread_id=? AND kind IN ('thread.resume','queue.resume','thread.limit') AND status IN ('pending','queued') ORDER BY position,id LIMIT 1";
    header_row(conn, SQL, vec![thread_value(thread)])
}

/// `message` (`:203`): the first delivery-kind intent still waiting.
pub fn message(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Option<IntentHeader>, EngineError> {
    const SQL: &str = "SELECT id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id FROM intents WHERE thread_id=? AND kind IN ('thread.create','thread.send','thread.fork','thread.switch','thread.merge') AND status IN ('pending','queued') ORDER BY position,id LIMIT 1";
    header_row(conn, SQL, vec![thread_value(thread)])
}

/// `undelivered` (`:210`).
pub fn undelivered(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Option<Intent>, EngineError> {
    const SQL: &str = "SELECT id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id,payload,error,uncertain FROM intents WHERE thread_id=? AND kind IN ('thread.send','thread.create') ORDER BY id DESC LIMIT 1";
    let Some(row) = stmt_cache::get_row(conn, SQL, vec![thread_value(thread)])? else {
        return Ok(None);
    };
    let failed = text(row.get("status")) == Some("failed");
    let acknowledged = row.get("acknowledged").and_then(cell_int) == Some(1);
    let uncertain = row.get("uncertain").and_then(cell_int) == Some(1);
    let submitted = row.get("submitted_generation").and_then(cell_int).is_some();
    let error = text(row.get("error"))
        .unwrap_or_default()
        .to_ascii_lowercase();
    let recoverable = error.contains("model_unavailable")
        || error.contains("session opening failed")
        || error.contains("delivery failed");
    if !failed || acknowledged || uncertain || submitted || !recoverable {
        return Ok(None);
    }
    Ok(Some(Intent::with_command(&row)?))
}

/// `uncertainSend` (`:227`).
pub fn uncertain_send(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    command_id: &str,
) -> Result<Option<Intent>, EngineError> {
    const SQL: &str = "SELECT id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id,payload FROM intents WHERE thread_id=? AND command_id=? AND uncertain=1 AND acknowledged=0 AND kind IN ('thread.create','thread.send','thread.fork','thread.switch','thread.merge') LIMIT 1";
    let Some(row) = stmt_cache::get_row(
        conn,
        SQL,
        vec![thread_value(thread), Value::Text(command_id.to_owned())],
    )?
    else {
        return Ok(None);
    };
    Ok(Some(Intent::with_command(&row)?))
}

/// `uncertainSends` (`:236`): every uncertain send, oldest first, read 64 at a time.
pub fn uncertain_sends(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Vec<Intent>, EngineError> {
    const SQL: &str = "SELECT id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id,payload FROM intents WHERE thread_id=? AND id>? AND uncertain=1 AND acknowledged=0 AND kind IN ('thread.create','thread.send','thread.fork','thread.switch','thread.merge') ORDER BY id LIMIT 64";
    let mut all = Vec::new();
    let mut after = 0i64;
    loop {
        let rows =
            stmt_cache::all_rows(conn, SQL, vec![thread_value(thread), Value::Integer(after)])?;
        for row in &rows {
            all.push(Intent::with_command(row)?);
        }
        if rows.len() < 64 {
            return Ok(all);
        }
        after = rows
            .last()
            .and_then(|row| row.get("id").and_then(cell_int))
            .unwrap_or(after);
    }
}

/// `queuedMessage` (`:251`).
pub fn queued_message(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Option<IntentHeader>, EngineError> {
    const SQL: &str = "SELECT id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id FROM intents WHERE thread_id=? AND kind IN ('thread.create','thread.send','thread.fork','thread.switch','thread.merge') AND delivery='queue' AND status IN ('pending','queued') ORDER BY position,id LIMIT 1";
    header_row(conn, SQL, vec![thread_value(thread)])
}

/// `childResult` (`:257`).
pub fn child_result(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Option<IntentHeader>, EngineError> {
    const SQL: &str = "SELECT id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id FROM intents WHERE thread_id=? AND kind='thread.send' AND trigger='subagent_result' AND status IN ('pending','queued') ORDER BY position,id LIMIT 1";
    header_row(conn, SQL, vec![thread_value(thread)])
}

/// `steerMessage` (`:263`).
pub fn steer_message(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Option<IntentHeader>, EngineError> {
    const SQL: &str = "SELECT id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id FROM intents WHERE thread_id=? AND kind='thread.send' AND delivery='steer' AND status IN ('pending','queued') ORDER BY position,id LIMIT 1";
    header_row(conn, SQL, vec![thread_value(thread)])
}

/// `personSteer` (`:273`).
pub fn person_steer(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Option<IntentHeader>, EngineError> {
    const SQL: &str = "SELECT id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id FROM intents WHERE thread_id=? AND kind='thread.send' AND delivery='steer' AND (trigger IS NULL OR trigger='user' OR id IN (SELECT intent_id FROM engine_steer_notes WHERE person=1)) AND status IN ('pending','queued') ORDER BY position,id LIMIT 1";
    header_row(conn, SQL, vec![thread_value(thread)])
}

/// `selectionAhead` (`:280`).
pub fn selection_ahead(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<bool, EngineError> {
    const SQL: &str = "SELECT 1 FROM intents WHERE thread_id=? AND status IN ('pending','queued','running') AND (kind IN ('thread.switch','thread.merge') OR (kind='thread.send' AND (json_type(payload,'$.payload.model') IS NOT NULL OR json_type(payload,'$.payload.options') IS NOT NULL))) LIMIT 1";
    Ok(stmt_cache::get_row(conn, SQL, vec![thread_value(thread)])?.is_some())
}

/// `placeAfter` (`:288`).
pub fn place_after(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    command_id: &str,
    leader: &str,
) -> Result<(), EngineError> {
    const SQL: &str = "UPDATE intents SET position=COALESCE((SELECT position FROM intents WHERE thread_id=? AND command_id=?),position) WHERE thread_id=? AND command_id=?";
    stmt_cache::run(
        conn,
        SQL,
        vec![
            thread_value(thread),
            Value::Text(leader.to_owned()),
            thread_value(thread),
            Value::Text(command_id.to_owned()),
        ],
    )?;
    Ok(())
}

/// `transition` (`:293`): a switch before a merge.
pub fn transition(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Option<IntentHeader>, EngineError> {
    const SQL: &str = "SELECT id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id FROM intents WHERE thread_id=? AND kind IN ('thread.switch','thread.merge') AND status IN ('pending','queued') ORDER BY CASE kind WHEN 'thread.switch' THEN 0 ELSE 1 END,position,id LIMIT 1";
    header_row(conn, SQL, vec![thread_value(thread)])
}

/// `runnableThreads` (`:299`), with the owner's fix: a thread whose intents wait with no
/// `engine_queue` row still runs, because the row is optional metadata since the queue's
/// pending read never depends on it.
pub fn runnable_threads(
    conn: &Arc<ace_store::Connection>,
    limit: i64,
) -> Result<Vec<String>, EngineError> {
    const SQL: &str = "SELECT DISTINCT i.thread_id FROM intents i LEFT JOIN engine_queue q ON q.thread_id=i.thread_id
      WHERE i.status IN ('pending','queued') AND (i.kind IN ('thread.resume','queue.resume','thread.limit','thread.switch','thread.merge') OR (COALESCE(q.paused,0)=0 AND COALESCE(q.limited,0)=0))
      AND NOT EXISTS(SELECT 1 FROM engine_transition_guards g WHERE g.thread_id=i.thread_id AND g.command_id<>i.command_id)
      AND NOT EXISTS(SELECT 1 FROM engine_slots s WHERE s.thread_id=i.thread_id)
      AND NOT EXISTS(SELECT 1 FROM thread_ownership o WHERE o.thread_id=i.thread_id AND o.state IN ('stopping','handing','moved')) LIMIT ?";
    let rows = stmt_cache::all_rows(conn, SQL, vec![Value::Integer(limit)])?;
    Ok(rows
        .iter()
        .filter_map(|row| row.get("thread_id").and_then(cell_text).map(str::to_owned))
        .collect())
}

/// `controls` (`:308`).
pub fn controls(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Vec<IntentHeader>, EngineError> {
    const SQL: &str = "SELECT id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id FROM intents WHERE thread_id=? AND kind NOT IN ('thread.create','thread.send','thread.fork','thread.switch','thread.merge','thread.resume','queue.resume','thread.limit') AND status='pending' ORDER BY position,id LIMIT 64";
    let rows = stmt_cache::all_rows(conn, SQL, vec![thread_value(thread)])?;
    rows.iter().map(IntentHeader::from_row).collect()
}

/// `awaiting` (`:315`).
pub fn awaiting(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Option<IntentHeader>, EngineError> {
    const SQL: &str = "SELECT id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id FROM intents WHERE thread_id=? AND awaiting=1 ORDER BY id LIMIT 1";
    header_row(conn, SQL, vec![thread_value(thread)])
}

/// `handedOver` (`:325`): the oldest input handed to the provider that no run has taken.
pub fn handed_over(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Option<IntentHeader>, EngineError> {
    const SQL: &str = "SELECT id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id FROM intents WHERE thread_id=? AND awaiting=1 AND submitted_generation IS NOT NULL ORDER BY id LIMIT 1";
    header_row(conn, SQL, vec![thread_value(thread)])
}

fn header_row(
    conn: &Arc<ace_store::Connection>,
    sql: &'static str,
    params: Vec<Value>,
) -> Result<Option<IntentHeader>, EngineError> {
    let row = stmt_cache::get_row(conn, sql, params)?;
    row.map(|row| IntentHeader::from_row(&row)).transpose()
}
