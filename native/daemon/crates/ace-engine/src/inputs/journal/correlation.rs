// SPDX-License-Identifier: Apache-2.0
//! `InputJournal.correlate` (`input-journal.ts:224`-`:293`, E5.4b): match a root user message to
//! the input ace sent it for, by native identity, then by echo alias, then by the oldest unmatched
//! sent input of that generation with the same signature.

use ace_json::Value;
use ace_store::stmt_cache;
use std::sync::Arc;

use crate::EngineError;
use crate::inputs::journal::{
    BY_SIGNATURE, ECHO, ECHO_ALIAS, IDENTITY, MATCHED, generation, origin, row_text,
};
use crate::inputs::origin::person_input;
use crate::inputs::signature::signature;
use crate::repository::residency::text;

/// Match a root user message to the input it echoes, rewriting the fact to that input's key.
pub fn correlate(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    fact: Value,
    root: &str,
    generation_value: Option<f64>,
) -> Result<Option<Value>, EngineError> {
    let kind = fact.get("type").and_then(Value::as_str).unwrap_or_default();
    let draft = fact.get("draft");
    if (kind != "item.upsert" && kind != "item.reconciled")
        || fact.get("agent").and_then(Value::as_str) != Some(root)
        || draft
            .and_then(|draft| draft.get("type"))
            .and_then(Value::as_str)
            != Some("message")
        || draft
            .and_then(|draft| draft.get("role"))
            .and_then(Value::as_str)
            == Some("assistant")
    {
        return Ok(Some(fact));
    }
    let Some(draft) = draft.cloned() else {
        return Ok(Some(fact));
    };
    let item = fact.get("item").and_then(Value::as_str).unwrap_or_default();
    let native_id = draft.get("nativeId").and_then(Value::as_str);
    let command_id = match native_id {
        Some(native_id) => identify_command(conn, thread, native_id)?,
        None => None,
    };
    if let Some(command_id) = command_id.as_deref()
        && origin(conn, thread, &format!("input:{command_id}"))?.is_none()
    {
        let mut rewritten = fact;
        let mut origin = ace_json::Map::new();
        origin.insert("kind", Value::from("person"));
        origin.insert("commandId", Value::from(command_id));
        if let Some(object) = rewritten.as_object_mut()
            && let Some(draft) = object.get_mut("draft").and_then(Value::as_object_mut)
        {
            draft.insert("origin", Value::Object(origin));
            draft.insert("synthetic", Value::Bool(false));
        }
        return Ok(Some(rewritten));
    }
    let alias = match command_id.as_deref() {
        Some(command_id) => Some(format!("input:{command_id}")),
        None => {
            let row = stmt_cache::get_row(
                conn,
                ECHO_ALIAS,
                vec![
                    text(thread),
                    text(item),
                    generation(generation_value),
                    generation(generation_value),
                ],
            )?;
            row.as_ref().and_then(|row| row_text(row, "item_key"))
        }
    };
    let role = draft
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if role != "user" && alias.is_none() {
        return Ok(Some(fact));
    }
    let draft_origin = draft.get("origin");
    if command_id.is_none()
        && draft_origin.is_some()
        && draft_origin
            .and_then(|origin| origin.get("kind"))
            .and_then(Value::as_str)
            != Some("person")
        && draft_origin
            .and_then(|origin| origin.get("commandId"))
            .and_then(Value::as_str)
            .is_none()
    {
        return Ok(Some(fact));
    }
    if alias.is_none() && draft.get("parts").is_none() {
        return Ok(Some(fact));
    }
    let key = match &alias {
        Some(key) => key.clone(),
        None => {
            let parts = draft.get("parts").and_then(Value::as_array);
            let hashed = signature(&parts.map(|parts| parts.to_vec()).unwrap_or_default());
            let row = stmt_cache::get_row(
                conn,
                BY_SIGNATURE,
                vec![text(thread), text(&hashed), generation(generation_value)],
            )?;
            match row.as_ref().and_then(|row| row_text(row, "item_key")) {
                Some(key) => key,
                None => return Ok(Some(fact)),
            }
        }
    };
    if key == item && alias.is_none() {
        return Ok(Some(fact));
    }
    stmt_cache::run(conn, MATCHED, vec![text(thread), text(&key)])?;
    stmt_cache::run(conn, ECHO, vec![text(thread), text(item), text(&key)])?;
    let Some(origin) = origin(conn, thread, &key)? else {
        return Err(EngineError::Records("Invalid message origin".to_owned()));
    };
    // Keep the person's original parts; provider input may contain expanded context.
    let mut moved = draft.clone();
    if let Some(object) = moved.as_object_mut() {
        object.remove("parts");
        let synthetic = !person_input(&origin);
        object.insert("origin", origin);
        object.insert("synthetic", Value::Bool(synthetic));
        let native_id = draft_native_id(&fact, item);
        object.insert("nativeId", Value::from(native_id.as_str()));
    }
    let mut rewritten = fact;
    if let Some(object) = rewritten.as_object_mut() {
        object.insert("item", Value::from(key.as_str()));
        object.insert("draft", moved);
    }
    Ok(Some(rewritten))
}

fn draft_native_id(fact: &Value, item: &str) -> String {
    fact.get("draft")
        .and_then(|draft| draft.get("nativeId"))
        .and_then(Value::as_str)
        .unwrap_or(item)
        .to_owned()
}

fn identify_command(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    native_id: &str,
) -> Result<Option<String>, EngineError> {
    let row = stmt_cache::get_row(conn, IDENTITY, vec![text(thread), text(native_id)])?;
    Ok(row.as_ref().and_then(|row| row_text(row, "command_id")))
}
