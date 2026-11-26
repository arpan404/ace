// SPDX-License-Identifier: Apache-2.0
//! The fold's small pure helpers: a fact's kind and text fields, a JSON field set, the facts a
//! provider error needs shaping for, and the events core emitted as JSON.

use ace_json::Value;

pub(crate) fn kind(value: &Value) -> &str {
    value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

pub(crate) fn text_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// Text as JSON carries it, a lone surrogate included (`JsString::to_rust`).
pub(crate) fn text_carrier(value: &Value, key: &str) -> Option<String> {
    match value.get(key) {
        Some(Value::String(text)) => Some(text.to_rust().into_owned()),
        _ => None,
    }
}

pub(crate) fn set(value: &mut Value, key: &str, next: Value) {
    if let Some(object) = value.as_object_mut() {
        object.insert(key, next);
    }
}

pub(crate) fn needs_shaping(fact: &Value) -> bool {
    match kind(fact) {
        "item.upsert" | "item.reconciled" => {
            fact.get("draft")
                .and_then(|draft| draft.get("type"))
                .and_then(Value::as_str)
                == Some("notice")
        }
        "turn.ended" => fact.get("error").is_some(),
        "process.exited" => fact.get("message").is_some(),
        _ => false,
    }
}

pub(crate) fn events_of(events: &[ace_core::emit::Event]) -> Vec<Value> {
    let mut json = String::new();
    ace_core::event_json::write_events(events, &mut json);
    match ace_json::parse(&json) {
        Ok(Value::Array(items)) => items.into_vec(),
        _ => Vec::new(),
    }
}
