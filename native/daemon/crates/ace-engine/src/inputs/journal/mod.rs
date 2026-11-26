// SPDX-License-Identifier: Apache-2.0
//! The input journal (`input-journal.ts:106`-`:294`, E5.4b): durable, indexed echo correlation.
//! Transcript history is never scanned on a frame.
//!
//! Every statement is the TypeScript's text, character for character, through the shared
//! connection's cached statements. The journal runs inside the caller's transaction; the
//! TypeScript's own `store.atomic` calls are the caller's frame (the receipt's or the fold's), so
//! a throw rolls the caller back exactly as `identify`'s nested savepoint would.

use ace_json::Value;
use ace_store::{Value as SqlValue, stmt_cache};
use std::sync::Arc;

use crate::EngineError;
use crate::inputs::origin::message_origin;
use crate::inputs::signature::{provider_input, signature};
use crate::repository::residency::{cell_text, text};

mod correlation;

pub use correlation::correlate;

pub const ORIGIN: &str = "SELECT origin FROM engine_inputs WHERE thread_id=? AND item_key=?";
pub const IDENTITY: &str =
    "SELECT command_id FROM engine_input_identities WHERE thread_id=? AND native_id=?";
pub const IDENTIFY: &str = "INSERT OR IGNORE INTO engine_input_identities VALUES (?,?,?)";
pub const ATTACH_RUN: &str = "UPDATE engine_inputs SET run_id=? WHERE thread_id=? AND item_key=?";
pub const RUN_OF: &str = "SELECT run_id FROM engine_inputs WHERE thread_id=? AND item_key=?";
pub const REPLACE: &str = "INSERT OR IGNORE INTO engine_input_replacements VALUES (?,?,?)";
pub const REPLACEMENT: &str =
    "SELECT replacement_id FROM engine_input_replacements WHERE thread_id=? AND command_id=?";
pub const KEY_FOR: &str =
    "SELECT command_id FROM engine_input_identities WHERE thread_id=? AND native_id=?";
pub const SENT_IN: &str =
    "SELECT 1 FROM engine_inputs WHERE thread_id=? AND item_key=? AND sent=1 AND generation IS ?";
pub const BIND_SENT: &str = "UPDATE engine_inputs SET run_id=? WHERE thread_id=? AND sent=1 AND run_id IS NULL AND generation IS ? RETURNING item_key";
pub const IN_RUNS: &str = "SELECT item_key FROM engine_inputs WHERE thread_id=? AND run_id=?";
pub const INVALIDATE_ECHO: &str =
    "DELETE FROM engine_input_echoes WHERE thread_id=? AND item_key=?";
pub const INVALIDATE: &str = "DELETE FROM engine_inputs WHERE thread_id=? AND item_key=?";
pub const RESTAMP: &str = "UPDATE engine_inputs SET origin=? WHERE thread_id=? AND item_key=?";
pub const REGISTER: &str =
    "INSERT OR IGNORE INTO engine_inputs(thread_id,item_key,signature,origin) VALUES (?,?,?,?)";
pub const SENDING: &str =
    "UPDATE engine_inputs SET signature=?,sent=1,generation=? WHERE thread_id=? AND item_key=?";
pub const ECHO_ALIAS: &str = "SELECT e.item_key FROM engine_input_echoes e JOIN engine_inputs i ON i.thread_id=e.thread_id AND i.item_key=e.item_key WHERE e.thread_id=? AND e.native_key=? AND (? IS NULL OR i.generation=?)";
pub const BY_SIGNATURE: &str = "SELECT item_key,origin FROM engine_inputs WHERE thread_id=? AND signature=? AND generation IS ? AND sent=1 AND matched=0 ORDER BY ordinal LIMIT 1";
pub const MATCHED: &str = "UPDATE engine_inputs SET matched=1 WHERE thread_id=? AND item_key=?";
pub const ECHO: &str = "INSERT OR IGNORE INTO engine_input_echoes VALUES (?,?,?)";

/// A generation parameter: absent binds NULL, so `generation IS ?` stays.
pub(crate) fn generation(value: Option<f64>) -> SqlValue {
    match value {
        None => SqlValue::Null,
        Some(number) => SqlValue::Real(number),
    }
}

/// A row cell as text.
pub(crate) fn row_text(row: &stmt_cache::Row, column: &str) -> Option<String> {
    row.get(column).and_then(cell_text).map(str::to_owned)
}

/// The stored origin of an input, validated as `MessageOrigin.parse` does.
pub fn origin(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    key: &str,
) -> Result<Option<Value>, EngineError> {
    let row = stmt_cache::get_row(conn, ORIGIN, vec![text(thread), text(key)])?;
    let Some(stored) = row.as_ref().and_then(|row| row_text(row, "origin")) else {
        return Ok(None);
    };
    match message_origin(&stored) {
        Some(origin) => Ok(Some(origin)),
        None => Err(EngineError::Records("Invalid message origin".to_owned())),
    }
}

/// `identify`: native metadata supplies identity only.
pub fn identify(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    identity: &Value,
) -> Result<(), EngineError> {
    // `MessageIdentity.parse(identity)`: the fields in schema order, and zod's own error text.
    let mut issues = Vec::new();
    let command_id = identity_string(identity, "commandId", None, &mut issues);
    let native_id = identity_string(identity, "nativeId", Some(256), &mut issues);
    if !issues.is_empty() {
        return Err(EngineError::Records(zod_issues(&issues)));
    }
    let (command_id, native_id) = (
        command_id.unwrap_or_default(),
        native_id.unwrap_or_default(),
    );
    let previous = stmt_cache::get_row(conn, IDENTITY, vec![text(thread), text(&native_id)])?;
    if let Some(previous) = previous
        .as_ref()
        .and_then(|row| row_text(row, "command_id"))
        && previous != command_id
    {
        return Err(EngineError::Records(
            "Provider reused an input message identity for a different command".to_owned(),
        ));
    }
    stmt_cache::run(
        conn,
        IDENTIFY,
        vec![text(thread), text(&native_id), text(&command_id)],
    )?;
    Ok(())
}

/// The run a delivery hands this input to; none until a run consumes it.
pub fn attach_run(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    key: &str,
    run: Option<&str>,
) -> Result<(), EngineError> {
    let run = match run {
        None => SqlValue::Null,
        Some(run) => text(run),
    };
    stmt_cache::run(conn, ATTACH_RUN, vec![run, text(thread), text(key)])?;
    Ok(())
}

/// The run that took input `key`; none until one does.
pub fn run_of(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    key: &str,
) -> Result<Option<String>, EngineError> {
    let row = stmt_cache::get_row(conn, RUN_OF, vec![text(thread), text(key)])?;
    Ok(row.as_ref().and_then(|row| row_text(row, "run_id")))
}

/// Input `command_id` was sent again as `replacement` (a queue resend).
pub fn replace(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    command_id: &str,
    replacement: &str,
) -> Result<(), EngineError> {
    stmt_cache::run(
        conn,
        REPLACE,
        vec![text(thread), text(command_id), text(replacement)],
    )?;
    Ok(())
}

/// The command that replaced input `command_id`, if it was sent again.
pub fn replacement(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    command_id: &str,
) -> Result<Option<String>, EngineError> {
    let row = stmt_cache::get_row(conn, REPLACEMENT, vec![text(thread), text(command_id)])?;
    Ok(row.as_ref().and_then(|row| row_text(row, "replacement_id")))
}

/// The transcript key of the input whose send carried native id `native_id`.
pub fn key_for(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    native_id: &str,
) -> Result<Option<String>, EngineError> {
    let row = stmt_cache::get_row(conn, KEY_FOR, vec![text(thread), text(native_id)])?;
    Ok(row
        .as_ref()
        .and_then(|row| row_text(row, "command_id"))
        .map(|command| format!("input:{command}")))
}

/// Whether session `generation` was handed this input: only its own deliveries bind runs.
pub fn sent_in(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    key: &str,
    generation_value: Option<f64>,
) -> Result<bool, EngineError> {
    let row = stmt_cache::get_row(
        conn,
        SENT_IN,
        vec![text(thread), text(key), generation(generation_value)],
    )?;
    Ok(row.is_some())
}

/// Inputs session `generation` was handed that no run has taken yet now belong to `run`.
pub fn bind_sent(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    run: &str,
    generation_value: Option<f64>,
) -> Result<Vec<String>, EngineError> {
    let rows = stmt_cache::all_rows(
        conn,
        BIND_SENT,
        vec![text(run), text(thread), generation(generation_value)],
    )?;
    Ok(rows
        .iter()
        .filter_map(|row| row_text(row, "item_key"))
        .collect())
}

/// The inputs any of `runs` took, in the runs' order.
pub fn in_runs(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    runs: &[String],
) -> Result<Vec<String>, EngineError> {
    let mut keys = Vec::new();
    for run in runs {
        let rows = stmt_cache::all_rows(conn, IN_RUNS, vec![text(thread), text(run)])?;
        keys.extend(rows.iter().filter_map(|row| row_text(row, "item_key")));
    }
    Ok(keys)
}

/// Takes an input out of delivery.
pub fn invalidate(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    key: &str,
) -> Result<(), EngineError> {
    stmt_cache::run(conn, INVALIDATE_ECHO, vec![text(thread), text(key)])?;
    stmt_cache::run(conn, INVALIDATE, vec![text(thread), text(key)])?;
    Ok(())
}

/// Correct an accepted input's origin once its delivery is known (a steer into a run).
pub fn restamp(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    key: &str,
    origin: &Value,
) -> Result<(), EngineError> {
    stmt_cache::run(
        conn,
        RESTAMP,
        vec![text(&ace_json::to_string(origin)), text(thread), text(key)],
    )?;
    Ok(())
}

/// Keep the signature of the person's parts and the origin at acceptance.
pub fn register(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    key: &str,
    parts: &[Value],
    origin: &Value,
) -> Result<(), EngineError> {
    stmt_cache::run(
        conn,
        REGISTER,
        vec![
            text(thread),
            text(key),
            text(&signature(parts)),
            text(&ace_json::to_string(origin)),
        ],
    )?;
    Ok(())
}

/// Re-sign with the provider's own rendering and record the generation at delivery.
pub fn sending(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    key: &str,
    parts: &[Value],
    provider: Option<&str>,
    generation_value: Option<f64>,
) -> Result<(), EngineError> {
    let rendered = provider_input(parts, provider)?;
    stmt_cache::run(
        conn,
        SENDING,
        vec![
            text(&signature(&rendered)),
            generation(generation_value),
            text(thread),
            text(key),
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests;

/// One `MessageIdentity` field as zod would read it: a string, within its bounds, or an issue.
fn identity_string(
    identity: &Value,
    field: &str,
    maximum: Option<usize>,
    issues: &mut Vec<String>,
) -> Option<String> {
    let Some(value) = identity.get(field) else {
        issues.push(invalid_type(field, "undefined"));
        return None;
    };
    let Some(text) = value.as_str() else {
        issues.push(invalid_type(field, received(value)));
        return None;
    };
    let units = text.encode_utf16().count();
    if units == 0 {
        issues.push(format!(
            "  {{\n    \"origin\": \"string\",\n    \"code\": \"too_small\",\n    \"minimum\": 1,\n    \"inclusive\": true,\n    \"path\": [\n      \"{field}\"\n    ],\n    \"message\": \"Too small: expected string to have >=1 characters\"\n  }}"
        ));
        return None;
    }
    if let Some(maximum) = maximum
        && units > maximum
    {
        issues.push(format!(
            "  {{\n    \"origin\": \"string\",\n    \"code\": \"too_big\",\n    \"maximum\": {maximum},\n    \"inclusive\": true,\n    \"path\": [\n      \"{field}\"\n    ],\n    \"message\": \"Too big: expected string to have <={maximum} characters\"\n  }}"
        ));
        return None;
    }
    Some(text.to_owned())
}

/// zod's `getParsedType` for a JSON value, as its message names it.
fn received(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn invalid_type(field: &str, received: &str) -> String {
    format!(
        "  {{\n    \"expected\": \"string\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"{field}\"\n    ],\n    \"message\": \"Invalid input: expected string, received {received}\"\n  }}"
    )
}

/// `ZodError.message`: the issues as `JSON.stringify(issues, null, 2)`.
fn zod_issues(issues: &[String]) -> String {
    format!("[\n{}\n]", issues.join(",\n"))
}
