// SPDX-License-Identifier: Apache-2.0
//! The queue's client views (`queue-store.ts:210`-`:336`): one message, the snapshot, the
//! 512 KiB-bounded page, the head and the editable entry. A missing `engine_queue` row no longer
//! hides the messages: the intents are read either way, and only the settings default.

use ace_json::{Map, Value};
use ace_store::{Value as SqlValue, stmt_cache};
use std::sync::Arc;

use super::record::RecoveryRecord;
use super::store;
use crate::repository::residency::{cell_int, cell_text};
use crate::{EngineError, EngineStore};

const QUEUED: &str = "SELECT payload,uncertain,(SELECT fell_back FROM engine_steer_notes WHERE intent_id=intents.id) AS fell_back FROM intents WHERE thread_id=? AND (trigger IS NULL OR trigger != 'subagent_result') AND ((kind IN ('thread.send','thread.create') AND status IN ('pending','queued')) OR (kind IN ('thread.send','thread.create','thread.resume','queue.resume','thread.limit') AND uncertain=1)) ORDER BY position,id LIMIT 256";
const AFTER: &str = "SELECT payload,uncertain,(SELECT fell_back FROM engine_steer_notes WHERE intent_id=intents.id) AS fell_back FROM intents WHERE thread_id=? AND (trigger IS NULL OR trigger != 'subagent_result') AND ((kind IN ('thread.send','thread.create') AND status IN ('pending','queued')) OR (kind IN ('thread.send','thread.create','thread.resume','queue.resume','thread.limit') AND uncertain=1)) AND (position>? OR (position=? AND id>?)) ORDER BY position,id LIMIT ?";
const CURSOR: &str = "SELECT position,id FROM intents WHERE thread_id=? AND command_id=? AND (trigger IS NULL OR trigger != 'subagent_result') AND (status IN ('pending','queued') OR uncertain=1)";
const HEAD: &str = "SELECT id FROM intents WHERE thread_id=? AND (trigger IS NULL OR trigger != 'subagent_result') AND ((kind IN ('thread.send','thread.create') AND status IN ('pending','queued')) OR (kind IN ('thread.send','thread.create','thread.resume','queue.resume','thread.limit') AND uncertain=1)) ORDER BY position,id LIMIT 1";
const EDITABLE: &str = "SELECT id,payload,uncertain FROM intents WHERE thread_id=? AND command_id=? AND (trigger IS NULL OR trigger != 'subagent_result') AND ((kind IN ('thread.send','thread.create') AND status IN ('pending','queued')) OR (kind IN ('thread.send','thread.create','thread.resume','queue.resume','thread.limit') AND uncertain=1))";

/// The page's text budget (`queue-store.ts:292`), in the stored payload's UTF-8 bytes.
pub const PAGE_BYTES: usize = 512 * 1024;
const DEFAULT_LIMIT: i64 = 16;

/// `message` (`:210`): one queued row as `QueuedMessage.parse` keeps it.
pub fn message(payload: &str, uncertain: bool, fell_back: bool) -> Result<Value, EngineError> {
    let command =
        ace_json::parse(payload).map_err(|_| EngineError::Records("Invalid queue entry".into()))?;
    let command_id = command
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| EngineError::Records("Invalid queue entry".into()))?;
    let payload = command
        .get("payload")
        .ok_or_else(|| EngineError::Records("Invalid queue entry".into()))?;
    let kind = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut map = Map::new();
    map.insert("id", Value::from(command_id));
    if !matches!(kind, "thread.send" | "thread.create") {
        let recovery = ["thread.resume", "queue.resume", "thread.limit"];
        if !uncertain || payload.get("threadId").is_none() || !recovery.contains(&kind) {
            return Err(EngineError::Records("Invalid queue entry".into()));
        }
        let mut text = Map::new();
        text.insert("type", Value::from("text"));
        text.insert("text", Value::from("Continue where you left off."));
        map.insert("input", Value::Array(vec![Value::Object(text)].into()));
        map.insert("delivery", Value::from("queue"));
        map.insert("state", Value::from("uncertain"));
        return Ok(Value::Object(map));
    }
    map.insert(
        "input",
        payload.get("input").cloned().unwrap_or(Value::Null),
    );
    if let Some(context) = payload.get("context") {
        map.insert("context", context.clone());
    }
    let delivery = if kind == "thread.send" {
        payload
            .get("delivery")
            .and_then(Value::as_str)
            .unwrap_or("queue")
    } else {
        "queue"
    };
    if !["queue", "steer"].contains(&delivery) {
        return Err(EngineError::Records("Invalid queue entry".into()));
    }
    map.insert("delivery", Value::from(delivery));
    if payload.get("model").is_some() || payload.get("options").is_some() {
        map.insert("requiresNextTurn", Value::Bool(true));
    }
    map.insert(
        "state",
        Value::from(if uncertain { "uncertain" } else { "queued" }),
    );
    if fell_back {
        map.insert("fellBack", Value::Bool(true));
    }
    Ok(Value::Object(map))
}

fn rows(
    conn: &Arc<ace_store::Connection>,
    sql: &'static str,
    params: Vec<SqlValue>,
) -> Result<Vec<Value>, EngineError> {
    let mut messages = Vec::new();
    for row in stmt_cache::all_rows(conn, sql, params)? {
        let payload = row.get("payload").and_then(cell_text).unwrap_or_default();
        messages.push(message(
            payload,
            row.get("uncertain").and_then(cell_int) == Some(1),
            row.get("fell_back").and_then(cell_int) == Some(1),
        )?);
    }
    Ok(messages)
}

/// `snapshot` (`:242`): the queue row's settings (or the defaults) plus every visible message.
pub fn snapshot(store: &EngineStore, thread: &str) -> Result<Value, EngineError> {
    let record = store::shown(store, thread)?;
    let messages = rows(
        store.conn(),
        QUEUED,
        vec![SqlValue::Text(thread.to_owned())],
    )?;
    Ok(queue_json(&record, thread, messages))
}

fn queue_json(record: &RecoveryRecord, thread: &str, messages: Vec<Value>) -> Value {
    let Value::Object(mut map) = record.to_json() else {
        return Value::Null;
    };
    map.insert("threadId", Value::from(thread));
    map.insert("messages", Value::Array(messages.into()));
    Value::Object(map)
}

/// `page` (`:266`): the versioned cursor and the 512 KiB cut after the first message.
pub fn page(store: &EngineStore, request: &Value) -> Result<Value, EngineError> {
    let thread = request
        .get("threadId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let after = request.get("after").and_then(Value::as_str);
    let expected = request
        .get("expectedRevision")
        .and_then(Value::as_f64)
        .map(|value| value as i64);
    let limit = request
        .get("limit")
        .and_then(Value::as_f64)
        .map(|value| value as i64)
        .unwrap_or(DEFAULT_LIMIT);
    let queue = store::shown(store, thread)?;
    if let Some(expected) = expected
        && expected != queue.revision
    {
        return Err(EngineError::Records("queue_conflict".into()));
    }
    if after.is_some() && expected.is_none() {
        return Err(EngineError::Records("queue_revision_required".into()));
    }
    let cursor = match after {
        None => None,
        Some(after) => stmt_cache::get_row(
            store.conn(),
            CURSOR,
            vec![
                SqlValue::Text(thread.to_owned()),
                SqlValue::Text(after.to_owned()),
            ],
        )?,
    };
    if after.is_some() && cursor.is_none() {
        return Err(EngineError::Records("invalid_queue_cursor".into()));
    }
    let position = cursor
        .as_ref()
        .and_then(|row| row.get("position").and_then(cell_int))
        .unwrap_or(-1);
    let id = cursor
        .as_ref()
        .and_then(|row| row.get("id").and_then(cell_int))
        .unwrap_or(-1);
    let all = stmt_cache::all_rows(
        store.conn(),
        AFTER,
        vec![
            SqlValue::Text(thread.to_owned()),
            SqlValue::Integer(position),
            SqlValue::Integer(position),
            SqlValue::Integer(id),
            SqlValue::Integer(limit + 1),
        ],
    )?;
    let mut messages = Vec::new();
    let mut bytes = 0usize;
    for row in &all {
        let payload = row.get("payload").and_then(cell_text).unwrap_or_default();
        let size = payload.len();
        if messages.len() as i64 >= limit || (!messages.is_empty() && bytes + size > PAGE_BYTES) {
            break;
        }
        bytes += size;
        messages.push(message(
            payload,
            row.get("uncertain").and_then(cell_int) == Some(1),
            row.get("fell_back").and_then(cell_int) == Some(1),
        )?);
    }
    let next = if all.len() > messages.len() {
        messages
            .last()
            .and_then(|message| message.get("id").cloned())
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let Value::Object(mut map) = queue_json(&queue, thread, messages) else {
        return Err(EngineError::Records("Invalid queue metadata".into()));
    };
    map.insert("total", Value::from(store::count(store.conn(), thread)?));
    map.insert("next", next);
    Ok(Value::Object(map))
}

/// `head` (`:307`): the first message the person sees queued.
pub fn head(store: &EngineStore, thread: &str) -> Result<Option<u32>, EngineError> {
    let row = stmt_cache::get_row(store.conn(), HEAD, vec![SqlValue::Text(thread.to_owned())])?;
    Ok(row
        .and_then(|row| row.get("id").and_then(cell_int))
        .map(|id| id as u32))
}

/// `editable` (`:320`): the command a queue edit replaces, with whether it is uncertain.
pub fn editable(
    store: &EngineStore,
    thread: &str,
    message: &str,
) -> Result<Option<(u32, Value, bool)>, EngineError> {
    let Some(row) = stmt_cache::get_row(
        store.conn(),
        EDITABLE,
        vec![
            SqlValue::Text(thread.to_owned()),
            SqlValue::Text(message.to_owned()),
        ],
    )?
    else {
        return Ok(None);
    };
    let id = row.get("id").and_then(cell_int).unwrap_or(0) as u32;
    let payload = row.get("payload").and_then(cell_text).unwrap_or_default();
    let command =
        ace_json::parse(payload).map_err(|_| EngineError::Records("Invalid queue entry".into()))?;
    Ok(Some((
        id,
        command,
        row.get("uncertain").and_then(cell_int) == Some(1),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn send(id: &str, delivery: Option<&str>) -> String {
        let mut payload = Map::new();
        payload.insert("type", Value::from("thread.send"));
        payload.insert("threadId", Value::from("t"));
        payload.insert("input", Value::Array(vec![Value::from("hi")].into()));
        if let Some(delivery) = delivery {
            payload.insert("delivery", Value::from(delivery));
        }
        let mut command = Map::new();
        command.insert("id", Value::from(id));
        command.insert("payload", Value::Object(payload));
        ace_json::to_string(&Value::Object(command))
    }

    #[test]
    fn a_queued_message_keeps_the_command_fields_the_queue_shows() {
        let message = message(&send("c1", Some("steer")), true, true).unwrap();
        assert_eq!(message.get("id").and_then(Value::as_str), Some("c1"));
        assert_eq!(
            message.get("delivery").and_then(Value::as_str),
            Some("steer")
        );
        assert_eq!(
            message.get("state").and_then(Value::as_str),
            Some("uncertain")
        );
        assert_eq!(message.get("fellBack"), Some(&Value::Bool(true)));
        assert!(message.get("context").is_none());
    }

    #[test]
    fn a_recovery_message_shows_the_continue_text() {
        let mut payload = Map::new();
        payload.insert("type", Value::from("thread.resume"));
        payload.insert("threadId", Value::from("t"));
        let mut command = Map::new();
        command.insert("id", Value::from("c2"));
        command.insert("payload", Value::Object(payload));
        let queued = message(&ace_json::to_string(&Value::Object(command)), true, false).unwrap();
        assert_eq!(
            queued
                .get("input")
                .and_then(|input| input.get(&0usize))
                .and_then(|part| part.get("text")),
            Some(&Value::from("Continue where you left off."))
        );
        assert!(message(&send("c3", None), false, false).is_ok());
    }
}
