// SPDX-License-Identifier: Apache-2.0
//! Raw payload capping (`raw.ts`). Snapshot facts use the same cap as the store's events,
//! including existing blob references, so a fact is rewritten key by key in the order it
//! arrived.

use crate::EngineError;
use ace_core::ace_tools::{normalize_ace_call, redact_ace_approval};
use ace_core::entity_model::InteractionRequest;
use ace_core::item_model::ToolCall;
use ace_json::Value;
use ace_store::{Connection, Value as Row, stmt_cache};
use std::sync::Arc;

fn map_of(value: &Value) -> Option<&ace_json::Map> {
    match value {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

fn map_mut(value: &mut Value) -> Option<&mut ace_json::Map> {
    match value {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    map_of(value)?.get(name)
}

fn is_kind(value: &Value, kinds: &[&str]) -> bool {
    matches!(field(value, "type"), Some(Value::String(text)) if kinds.contains(&text.as_str()))
}

/// `{ ...previous, request }` with the approval redaction's two replacements.
fn redact_request(fact: &mut Value) {
    let Some(request) = field(fact, "request").cloned() else {
        return;
    };
    let Ok(mut typed) = ace_json::from_value::<InteractionRequest>(&request) else {
        return;
    };
    if !redact_ace_approval(&mut typed) {
        return;
    }
    let mut redacted = request;
    if let Some(container) = map_mut(&mut redacted) {
        container.insert("title", Value::String("Approve computer input".into()));
        container.insert(
            "description",
            Value::String("Input content is redacted.".into()),
        );
        if let InteractionRequest::Approval {
            target: Some(target),
            ..
        } = &typed
            && let Some(target_map) = container.get_mut("target").and_then(map_mut)
        {
            if let Some(input) = &target.input {
                target_map.insert("input", input.0.to_value());
            }
            if let Some(description) = &target.description {
                target_map.insert("description", Value::String(description.clone().into()));
            }
        }
    }
    let Some(container) = map_mut(fact) else {
        return;
    };
    container.insert("request", redacted);
    container.insert(
        "raw",
        ace_json::json!([{"type": "ace.private-input", "data": {"redacted": true}}]),
    );
}

/// Cap one fact's raw payloads in place, branch for branch with `raw.ts:8`.
pub fn cap_fact(
    cap_raw: &mut dyn FnMut(Value) -> Result<Value, EngineError>,
    mut fact: Value,
    previous: Option<&ToolCall>,
) -> Result<Value, EngineError> {
    if is_kind(&fact, &["interaction.opened"]) {
        redact_request(&mut fact);
    }
    let tool_draft = is_kind(&fact, &["item.upsert", "item.reconciled"])
        && matches!(field(&fact, "draft").and_then(|draft| field(draft, "type")), Some(Value::String(kind)) if kind.as_str() == "tool_call");
    if tool_draft
        && let Some(call) = field(&fact, "draft")
            .and_then(|draft| field(draft, "call"))
            .cloned()
        && let Some(call_map) = map_of(&call)
    {
        let normalized = normalize_ace_call(call_map, previous);
        if let Some(draft) = map_mut_if(&mut fact, "draft").and_then(map_mut) {
            draft.insert("call", Value::Object(normalized));
        }
    }
    if tool_draft {
        let raw = field(&fact, "draft")
            .and_then(|draft| field(draft, "call"))
            .and_then(|call| field(call, "raw"))
            .cloned();
        if let Some(raw) = raw {
            let capped = cap_raw(raw)?;
            if let Some(call) = map_mut_if(&mut fact, "draft")
                .and_then(map_mut)
                .and_then(|draft| draft.get_mut("call"))
                .and_then(map_mut)
            {
                call.insert("raw", capped);
            }
        }
    }
    let draft_raw = if is_kind(&fact, &["item.upsert", "item.reconciled"]) {
        field(&fact, "draft")
            .and_then(|draft| field(draft, "raw"))
            .cloned()
    } else {
        None
    };
    if let Some(raw) = draft_raw {
        let capped = cap_raw(raw)?;
        if let Some(draft) = map_mut_if(&mut fact, "draft").and_then(map_mut) {
            draft.insert("raw", capped);
        }
    }
    let outer_raw = if is_kind(&fact, &["interaction.opened", "background.started"]) {
        field(&fact, "raw").cloned()
    } else {
        None
    };
    if let Some(raw) = outer_raw {
        let capped = cap_raw(raw)?;
        if let Some(container) = map_mut(&mut fact) {
            container.insert("raw", capped);
        }
    }
    Ok(fact)
}

fn map_mut_if<'a>(value: &'a mut Value, name: &str) -> Option<&'a mut Value> {
    map_mut(value)?.get_mut(name)
}

/// `readRawBlob` (`raw.ts:43`). The shell's facade member parses the id first, so the empty-id
/// refusal is unreachable from JavaScript; Rust refuses it anyway.
pub fn read_raw_blob(conn: &Arc<Connection>, id: &str) -> Result<Option<Vec<u8>>, EngineError> {
    if id.is_empty() {
        return Err(EngineError::InvalidRawBlobId);
    }
    let params = vec![Row::Text(id.to_string())];
    // Keep pre-ADR-0006 engine envelopes readable after upgrade.
    let row = stmt_cache::get_row_raw(conn, "SELECT bytes FROM blobs WHERE id=?", params.clone())?
        .or(stmt_cache::get_row_raw(
            conn,
            "SELECT bytes FROM engine_raw_blobs WHERE id=?",
            params,
        )?);
    let Some(row) = row else {
        return Ok(None);
    };
    match row.into_iter().next() {
        Some(Row::Blob(bytes)) => Ok(Some(bytes)),
        // `value === undefined` returns nothing; any other non-blob is the store's bug.
        None | Some(Row::Null) => Ok(None),
        Some(_) => Err(EngineError::InvalidStoredRawBlob),
    }
}
