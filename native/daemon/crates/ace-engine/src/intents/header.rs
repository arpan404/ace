// SPDX-License-Identifier: Apache-2.0
//! `IntentHeader` (`intents.ts:9`-`:50`): one live intent's indexed row. `status` and `delivery`
//! decode strictly, as zod does; a row this build cannot read is passed to `headers`'s
//! `unreadable` callback and skipped, or fails the read when there is none.

use ace_store::stmt_cache::Row;
use ace_store::{Value, stmt_cache};
use std::sync::Arc;

use crate::EngineError;

/// The columns every header read selects, in `intents.ts:29`'s order.
pub const COLUMNS: &str = "id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id";

pub const STATUSES: [&str; 5] = ["pending", "queued", "running", "done", "failed"];
pub const DELIVERIES: [&str; 2] = ["queue", "steer"];
pub const TRIGGERS: [&str; 11] = [
    "user",
    "restart",
    "limit_resume",
    "spawn",
    "parent_agent",
    "background_completion",
    "subagent_result",
    "goal",
    "queue",
    "schedule",
    "unknown",
];

/// One intent's header, as `Header.parse` keeps it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntentHeader {
    pub id: u32,
    pub thread_id: String,
    pub command_id: String,
    pub kind: String,
    pub status: String,
    pub attempts: i64,
    pub awaiting: bool,
    pub ack_target: Option<u32>,
    pub delivery: String,
    pub acknowledged: bool,
    pub resolution_id: Option<String>,
    pub resolution_generation: Option<i64>,
    pub submitted_generation: Option<i64>,
    pub trigger: Option<String>,
}

/// A stored intent: its header and the command payload the row holds.
#[derive(Debug, Clone)]
pub struct Intent {
    pub header: IntentHeader,
    pub command: ace_json::Value,
}

fn text(row: &Row, key: &str) -> Result<String, EngineError> {
    match row.get(key) {
        Some(Value::Text(value)) => Ok(value.clone()),
        _ => Err(unreadable(key)),
    }
}

fn integer(row: &Row, key: &str) -> Result<i64, EngineError> {
    match row.get(key) {
        Some(Value::Integer(value)) => Ok(*value),
        _ => Err(unreadable(key)),
    }
}

fn optional_integer(row: &Row, key: &str) -> Result<Option<i64>, EngineError> {
    match row.get(key) {
        Some(Value::Null) | None => Ok(None),
        Some(Value::Integer(value)) => Ok(Some(*value)),
        _ => Err(unreadable(key)),
    }
}

fn optional_text(row: &Row, key: &str) -> Result<Option<String>, EngineError> {
    match row.get(key) {
        Some(Value::Null) | None => Ok(None),
        Some(Value::Text(value)) => Ok(Some(value.clone())),
        _ => Err(unreadable(key)),
    }
}

fn flag(row: &Row, key: &str) -> Result<bool, EngineError> {
    match row.get(key) {
        Some(Value::Integer(1)) => Ok(true),
        Some(Value::Integer(0)) => Ok(false),
        _ => Err(unreadable(key)),
    }
}

fn member<'a>(allowed: &'a [&'a str], value: String, key: &str) -> Result<String, EngineError> {
    if allowed.contains(&value.as_str()) {
        Ok(value)
    } else {
        Err(unreadable(key))
    }
}

fn unreadable(key: &str) -> EngineError {
    EngineError::Records(format!("Invalid intent header: {key}"))
}

impl IntentHeader {
    /// `header(row)` (`intents.ts:33`): the row as the strict schema reads it.
    pub fn from_row(row: &Row) -> Result<IntentHeader, EngineError> {
        let id = integer(row, "id")?;
        if id <= 0 {
            return Err(unreadable("id"));
        }
        let attempts = integer(row, "attempts")?;
        if attempts < 0 {
            return Err(unreadable("attempts"));
        }
        let ack_target = optional_integer(row, "ack_target")?;
        if ack_target.is_some_and(|value| value <= 0) {
            return Err(unreadable("ack_target"));
        }
        let resolution_generation = optional_integer(row, "resolution_generation")?;
        if resolution_generation.is_some_and(|value| value < 0) {
            return Err(unreadable("resolution_generation"));
        }
        let submitted_generation = optional_integer(row, "submitted_generation")?;
        if submitted_generation.is_some_and(|value| value < 0) {
            return Err(unreadable("submitted_generation"));
        }
        let status = member(&STATUSES, text(row, "status")?, "status")?;
        let delivery = member(&DELIVERIES, text(row, "delivery")?, "delivery")?;
        let trigger = optional_text(row, "trigger")?
            .map(|trigger| member(&TRIGGERS, trigger, "trigger"))
            .transpose()?;
        Ok(IntentHeader {
            id: id as u32,
            thread_id: text(row, "thread_id")?,
            command_id: text(row, "command_id")?,
            kind: text(row, "kind")?,
            status,
            attempts,
            awaiting: flag(row, "awaiting")?,
            ack_target: ack_target.map(|value| value as u32),
            delivery,
            acknowledged: flag(row, "acknowledged")?,
            resolution_id: optional_text(row, "resolution_id")?,
            resolution_generation,
            submitted_generation,
            trigger,
        })
    }
}

impl Intent {
    /// The row and its payload as `claim`/`uncertainSends` read it.
    pub fn with_command(row: &Row) -> Result<Intent, EngineError> {
        let payload = text(row, "payload")?;
        let command = ace_json::parse(&payload)
            .map_err(|_| EngineError::Records("Invalid queue entry".into()))?;
        Ok(Intent {
            header: IntentHeader::from_row(row)?,
            command,
        })
    }
}

/// `unreadable`'s signature: the row's thread and why this build can't read it.
pub type Unreadable<'a> = &'a mut dyn FnMut(&str, &EngineError);

/// `headers` (`intents.ts:133`): live intents by `id>?`, 64 at a time, skipping (or failing on)
/// a row the decoder refuses.
pub fn headers(
    conn: &Arc<ace_store::Connection>,
    thread: Option<&str>,
    mut unreadable: Option<Unreadable<'_>>,
) -> Result<Vec<IntentHeader>, EngineError> {
    const ALL: &str = "SELECT id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id FROM intents WHERE id>? AND (status IN ('pending','queued','running') OR awaiting=1 OR uncertain=1) ORDER BY id LIMIT 64";
    const THREAD: &str = "SELECT id,command_id,thread_id,kind,status,attempts,awaiting,ack_target,delivery,acknowledged,trigger,submitted_generation,resolution_generation,resolution_id FROM intents WHERE thread_id=? AND id>? AND (status IN ('pending','queued','running') OR awaiting=1 OR uncertain=1) ORDER BY id LIMIT 64";
    let mut all = Vec::new();
    let mut after = 0i64;
    loop {
        let rows = match thread {
            None => stmt_cache::all_rows(conn, ALL, vec![Value::Integer(after)])?,
            Some(thread) => stmt_cache::all_rows(
                conn,
                THREAD,
                vec![Value::Text(thread.to_owned()), Value::Integer(after)],
            )?,
        };
        if rows.is_empty() {
            return Ok(all);
        }
        for row in rows {
            after = integer(&row, "id")?;
            match IntentHeader::from_row(&row) {
                Ok(header) => all.push(header),
                Err(error) => match unreadable.as_mut() {
                    Some(callback) => callback(&text(&row, "thread_id")?, &error),
                    None => return Err(error),
                },
            }
        }
    }
}
