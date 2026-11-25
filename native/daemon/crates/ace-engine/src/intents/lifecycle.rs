// SPDX-License-Identifier: Apache-2.0
//! An intent's lifecycle writes (`intents.ts:74`-`:91`, `:379`-`:456`): acceptance, claim, the
//! hand-over, submission, deferral, the queue fallback and completion. All of it runs on the
//! caller's transaction when there is one (a receipt), or in these calls' own.

use ace_json::Value as Json;
use ace_store::stmt_cache;

use super::header::{Intent, IntentHeader};
use crate::queue;
use crate::repository::residency::cell_text;
use crate::{EngineError, EngineStore};

const INSERT: &str = "INSERT INTO intents
        (command_id,thread_id,kind,payload,status,resolution_id,position,delivery,trigger,resolution_generation) VALUES (?,?,?,?,'pending',?,?,?,?,?)";
const CLAIM: &str = "SELECT id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id,payload FROM intents WHERE id=? AND status IN ('pending','queued')";
const BEGIN_RECOVERY: &str = "INSERT INTO engine_state_records VALUES (?, 'engineRecovery', 'root', ?) ON CONFLICT(thread_id,section,key) DO UPDATE SET value=excluded.value";
const BEGIN_SEND: &str = "UPDATE intents SET awaiting=?, ack_target=?, acknowledged=0 WHERE id=?";
const SUBMIT: &str = "UPDATE intents SET submitted_generation=? WHERE id=? AND status='running'";
const JOIN_TURN: &str = "UPDATE intents SET awaiting=0, ack_target=NULL WHERE id=? AND awaiting=1";
const SUBMITTED: &str = "SELECT submitted_generation FROM intents WHERE id=?";
const DEFER: &str = "UPDATE intents SET status='queued',awaiting=0,ack_target=NULL,submitted_generation=NULL,uncertain=0,acknowledged=0 WHERE id=?";
const REQUEUE: &str = "UPDATE intents SET status='queued',delivery='queue',
      payload=json_set(payload,'$.payload.delivery','queue'),awaiting=0,ack_target=NULL,
      submitted_generation=NULL,uncertain=0,acknowledged=0,error=? WHERE id=?";
const MARK: &str =
    "UPDATE intents SET status=?,error=?,awaiting=CASE WHEN ?='failed' THEN 0 ELSE awaiting END,
        attempts=attempts+? WHERE id=?";

/// `add` (`intents.ts:74`): the accepted command, its queue position and its attachments. The
/// payload text is the command as the caller holds it (E5.4's callers decode and serialize at
/// the site the TypeScript parsed).
pub fn add(
    store: &EngineStore,
    command: &Json,
    thread: &str,
    resolution_id: Option<&str>,
    generation: Option<i64>,
) -> Result<(), EngineError> {
    let command_id = command
        .get("id")
        .and_then(Json::as_str)
        .ok_or_else(|| EngineError::Records("Invalid intent identity".into()))?;
    let payload_type = command
        .get("payload")
        .and_then(|payload| payload.get("type"))
        .and_then(Json::as_str)
        .ok_or_else(|| EngineError::Records("Invalid intent identity".into()))?;
    let delivery = if payload_type == "thread.send" {
        command
            .get("payload")
            .and_then(|payload| payload.get("delivery"))
            .and_then(Json::as_str)
            .unwrap_or("queue")
    } else {
        "queue"
    };
    let trigger = if matches!(payload_type, "thread.send" | "thread.create") {
        command
            .get("payload")
            .and_then(|payload| payload.get("trigger"))
            .and_then(Json::as_str)
    } else {
        None
    };
    let conn = store.conn();
    let position = queue::store::position(conn, thread)?;
    let payload = ace_json::to_string(command);
    let (_, id) = stmt_cache::run(
        conn,
        INSERT,
        vec![
            ace_store::Value::Text(command_id.to_owned()),
            ace_store::Value::Text(thread.to_owned()),
            ace_store::Value::Text(payload_type.to_owned()),
            ace_store::Value::Text(payload),
            resolution_id.map_or(ace_store::Value::Null, |value| {
                ace_store::Value::Text(value.to_owned())
            }),
            ace_store::Value::Integer(position),
            ace_store::Value::Text(delivery.to_owned()),
            trigger.map_or(ace_store::Value::Null, |value| {
                ace_store::Value::Text(value.to_owned())
            }),
            generation.map_or(ace_store::Value::Null, ace_store::Value::Integer),
        ],
    )?;
    queue::messages::track(conn, id, thread, command)
}

/// `claim` (`:379`): the intent becomes `running`, or none when it already moved.
pub fn claim(store: &EngineStore, entry: &IntentHeader) -> Result<Option<Intent>, EngineError> {
    store.atomic(|tx| {
        let Some(row) =
            stmt_cache::get_row(tx.conn(), CLAIM, vec![ace_store::Value::Integer(entry.id)])?
        else {
            return Ok(None);
        };
        let intent = Intent::with_command(&row)?;
        mark_in(tx.conn(), &intent.header, "running", None)?;
        Ok(Some(intent))
    })
}

/// `beginSend` (`:390`): a recovery attempt records its continuation; every attempt starts
/// unacknowledged.
pub fn begin_send(
    conn: &std::sync::Arc<ace_store::Connection>,
    intent: &IntentHeader,
    target: Option<i64>,
) -> Result<(), EngineError> {
    if target.is_some()
        && matches!(
            intent.kind.as_str(),
            "thread.resume" | "queue.resume" | "thread.limit"
        )
    {
        stmt_cache::run(
            conn,
            BEGIN_RECOVERY,
            vec![
                ace_store::Value::Text(intent.thread_id.clone()),
                ace_store::Value::Text(intent.id.to_string()),
            ],
        )?;
    }
    stmt_cache::run(
        conn,
        BEGIN_SEND,
        vec![
            ace_store::Value::Integer(i64::from(target.is_some())),
            target.map_or(ace_store::Value::Null, |value| {
                ace_store::Value::Integer(value)
            }),
            ace_store::Value::Integer(intent.id),
        ],
    )?;
    Ok(())
}

/// `submit` (`:405`).
pub fn submit(
    conn: &std::sync::Arc<ace_store::Connection>,
    intent: &IntentHeader,
    generation: i64,
) -> Result<(), EngineError> {
    stmt_cache::run(
        conn,
        SUBMIT,
        vec![
            ace_store::Value::Integer(generation),
            ace_store::Value::Integer(intent.id),
        ],
    )?;
    Ok(())
}

/// `joinRunningTurn` (`:415`): a steer handed into a running turn is not awaited later.
pub fn join_running_turn(
    conn: &std::sync::Arc<ace_store::Connection>,
    intent: &IntentHeader,
) -> Result<(), EngineError> {
    stmt_cache::run(conn, JOIN_TURN, vec![ace_store::Value::Integer(intent.id)])?;
    Ok(())
}

/// `submitted` (`:420`).
pub fn submitted(
    conn: &std::sync::Arc<ace_store::Connection>,
    intent: i64,
) -> Result<Option<i64>, EngineError> {
    let row = stmt_cache::get_row(conn, SUBMITTED, vec![ace_store::Value::Integer(intent)])?;
    Ok(row.and_then(|row| {
        row.get("submitted_generation")
            .and_then(|value| match value {
                ace_store::Value::Integer(value) => Some(*value),
                _ => None,
            })
    }))
}

/// `defer` (`:426`): a claimed input never submitted goes back to the queue.
pub fn defer(
    conn: &std::sync::Arc<ace_store::Connection>,
    intent: &IntentHeader,
) -> Result<(), EngineError> {
    stmt_cache::run(conn, DEFER, vec![ace_store::Value::Integer(intent.id)])?;
    Ok(())
}

/// `requeue` (`:435`): a steer the provider refused unread becomes the next queued message.
pub fn requeue(
    conn: &std::sync::Arc<ace_store::Connection>,
    intent: &IntentHeader,
    error: &str,
) -> Result<(), EngineError> {
    stmt_cache::run(
        conn,
        REQUEUE,
        vec![
            ace_store::Value::Text(error.to_owned()),
            ace_store::Value::Integer(intent.id),
        ],
    )?;
    Ok(())
}

/// `mark` (`:443`): a done or failed intent releases its attachments' queue rows.
pub fn mark(
    store: &EngineStore,
    intent: &IntentHeader,
    status: &str,
    error: Option<&str>,
) -> Result<(), EngineError> {
    store.atomic(|tx| {
        mark_in(tx.conn(), intent, status, error)?;
        if matches!(status, "done" | "failed") {
            queue::messages::prune(tx.conn(), intent.id)?;
        }
        Ok(())
    })
}

fn mark_in(
    conn: &std::sync::Arc<ace_store::Connection>,
    intent: &IntentHeader,
    status: &str,
    error: Option<&str>,
) -> Result<(), EngineError> {
    stmt_cache::run(
        conn,
        MARK,
        vec![
            ace_store::Value::Text(status.to_owned()),
            error.map_or(ace_store::Value::Null, |value| {
                ace_store::Value::Text(value.to_owned())
            }),
            ace_store::Value::Text(status.to_owned()),
            ace_store::Value::Integer(i64::from(status == "running")),
            ace_store::Value::Integer(intent.id),
        ],
    )?;
    Ok(())
}

/// `cancelled` (`repository.ts:487`): a Stop's own words for an intent it failed.
pub fn cancelled(
    conn: &std::sync::Arc<ace_store::Connection>,
    intent: i64,
) -> Result<bool, EngineError> {
    const SQL: &str = "SELECT 1 FROM intents WHERE id=? AND status='failed' AND error='Cancelled before delivery'";
    Ok(stmt_cache::get_row(conn, SQL, vec![ace_store::Value::Integer(intent)])?.is_some())
}

/// The thread an intent belongs to (`queue-store.ts:362`).
pub fn thread_of(
    conn: &std::sync::Arc<ace_store::Connection>,
    intent: i64,
) -> Result<Option<String>, EngineError> {
    const SQL: &str = "SELECT thread_id FROM intents WHERE id=?";
    let row = stmt_cache::get_row(conn, SQL, vec![ace_store::Value::Integer(intent)])?;
    Ok(row
        .as_ref()
        .and_then(|row| row.get("thread_id"))
        .and_then(cell_text)
        .map(str::to_owned))
}
