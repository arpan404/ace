// SPDX-License-Identifier: Apache-2.0
//! The rules `packages/protocol` states with `.refine()`, which JSON Schema can't express and
//! the generated types therefore don't enforce. Zod's answer stands: a message Zod rejects is
//! rejected here, with the same rule named.
//!
//! Each function takes the parsed body as Zod sees it (before stripping), so a rule about a
//! field Zod's output drops still reads what the client sent.

use ace_json::{Array, Map, Value};

use crate::error::WireError;

/// The client-message rules, by `type`.
pub fn client(type_: &str, value: &Value) -> Result<(), WireError> {
    match type_ {
        "hello" => hello(value),
        _ => Ok(()),
    }
}

/// The server-message rules, by `type`.
pub fn server(type_: &str, value: &Value) -> Result<(), WireError> {
    match type_ {
        "snapshot" => snapshot(value),
        "events" => events(value),
        "progress" => {
            let map = object(value);
            match (number(map, "afterSeq"), number(map, "throughSeq")) {
                (Some(after), Some(through)) if through < after => {
                    Err(rule("progress", "throughSeq must be >= afterSeq"))
                }
                _ => Ok(()),
            }
        }
        "items.page" => items_page(value),
        _ => Ok(()),
    }
}

/// `hello`: exactly one credential; `machineCode` and `link` only with a grant.
fn hello(value: &Value) -> Result<(), WireError> {
    let map = object(value);
    let credentials = ["token", "ticket", "grant"]
        .iter()
        .filter(|key| map.is_some_and(|map| map.get(**key).is_some()))
        .count();
    if credentials != 1 {
        return Err(rule(
            "hello",
            "exactly one of token, ticket and grant is required",
        ));
    }
    let has = |key: &str| map.is_some_and(|map| map.get(key).is_some());
    if has("machineCode") && !has("grant") {
        return Err(rule("hello", "machineCode only with grant"));
    }
    if has("link") && !has("grant") {
        return Err(rule("hello", "link only with grant"));
    }
    Ok(())
}

/// `snapshot`: one cursor in the envelope and the view; a thread view's items all carry their
/// creation sequence.
fn snapshot(value: &Value) -> Result<(), WireError> {
    let map = object(value);
    let view = map.and_then(|map| map.get("view")).and_then(object);
    match (number(map, "seq"), number(view, "seq")) {
        (Some(seq), Some(view_seq)) if seq != view_seq => {
            return Err(rule("snapshot", "seq must equal view.seq"));
        }
        _ => {}
    }
    if text(view, "kind") != Some("thread") {
        return Ok(());
    }
    let Some(item_order) = view.and_then(|view| view.get("itemOrder")).and_then(array) else {
        return Ok(());
    };
    let item_seqs = view.and_then(|view| view.get("itemSeqs")).and_then(object);
    for id in item_order {
        let Value::String(id) = id else {
            return Err(rule("snapshot", "itemOrder holds strings"));
        };
        let found = item_seqs.is_some_and(|seqs| seqs.get(id.as_str()).is_some());
        if !found {
            return Err(rule(
                "snapshot",
                "every snapshot item needs its creation sequence",
            ));
        }
    }
    Ok(())
}

/// `events`: coverage ordered, deltas' `firstSeq` at most their `seq`, and every event inside
/// the declared interval.
fn events(value: &Value) -> Result<(), WireError> {
    let map = object(value);
    let after = number(map, "afterSeq");
    let through = number(map, "throughSeq");
    if let (Some(after), Some(through)) = (after, through)
        && through < after
    {
        return Err(rule("events", "throughSeq must be >= afterSeq"));
    }
    let Some(list) = map.and_then(|map| map.get("events")).and_then(array) else {
        return Ok(());
    };
    let mut previous = after;
    for event in list {
        let event = object(event);
        let seq = number(event, "seq");
        let first = number(event, "firstSeq");
        if let (Some(first), Some(seq)) = (first, seq) {
            let payload = event
                .and_then(|event| event.get("payload"))
                .and_then(object);
            if text(payload, "type") != Some("item.delta") || first > seq {
                return Err(rule(
                    "events",
                    "firstSeq is allowed only on item.delta and must be <= seq",
                ));
            }
        }
        let start = first.or(seq);
        if let (Some(start), Some(seq)) = (start, seq) {
            if previous.is_some_and(|previous| start <= previous) {
                return Err(rule("events", "events are ordered by (firstSeq ?? seq)"));
            }
            if through.is_some_and(|through| seq > through) {
                return Err(rule("events", "every event's seq is at most throughSeq"));
            }
        }
        previous = seq.or(previous);
    }
    Ok(())
}

/// `items.page`: every item carries its creation sequence.
fn items_page(value: &Value) -> Result<(), WireError> {
    let map = object(value);
    let Some(items) = map.and_then(|map| map.get("items")).and_then(array) else {
        return Ok(());
    };
    let item_seqs = map.and_then(|map| map.get("itemSeqs")).and_then(object);
    for item in items {
        let id = text(object(item), "id");
        let found = id.is_some_and(|id| item_seqs.is_some_and(|seqs| seqs.get(id).is_some()));
        if !found {
            return Err(rule("items.page", "itemSeqs holds every item's sequence"));
        }
    }
    Ok(())
}

fn rule(type_: &str, rule: &'static str) -> WireError {
    WireError::Refinement {
        type_: type_.to_string(),
        rule,
    }
}

fn object(value: &Value) -> Option<&Map> {
    match value {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

fn array(value: &Value) -> Option<&Array> {
    match value {
        Value::Array(items) => Some(items),
        _ => None,
    }
}

fn number(map: Option<&Map>, key: &str) -> Option<f64> {
    match map?.get(key) {
        Some(Value::Number(number)) => Some(number.value()),
        _ => None,
    }
}

fn text<'a>(map: Option<&'a Map>, key: &str) -> Option<&'a str> {
    match map?.get(key) {
        Some(Value::String(text)) => Some(text.as_str()),
        _ => None,
    }
}
