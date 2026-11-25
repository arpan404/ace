// SPDX-License-Identifier: Apache-2.0
//! The queued message's own rows (`queue-store.ts:337`-`:409`): attachment retention and
//! tracking, edits, removals, the person's reordering, and the uncertain flag.

use ace_json::Value as Json;
use ace_store::{Value, stmt_cache};
use std::sync::Arc;

use crate::EngineError;
use crate::repository::residency::{cell_int, cell_text};

const UNCERTAIN: &str = "UPDATE intents SET uncertain=? WHERE id=?";
const PRUNE: &str = "DELETE FROM engine_queue_attachments WHERE intent_id=? AND EXISTS(SELECT 1 FROM intents WHERE id=? AND status IN ('done','failed') AND awaiting=0 AND uncertain=0)";

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
