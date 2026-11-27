// SPDX-License-Identifier: Apache-2.0
//! Thread statuses as a reader that predates the `moved` state (ADR 0191) can read them. Ports
//! `olderStatus` and `olderStatuses` from `packages/projection/src/older-status.ts`: a moved
//! status reads `waiting` on `upstream`, in every message field that holds a thread status.
//! Provider payloads (`raw`) are never looked into, and any other message is returned as it
//! came.

use ace_json::{JsString, Map, Value};

use crate::js::field_text;

fn status_is_moved(status: &Value) -> bool {
    field_text(status, "state").is_some_and(|state| state == "moved")
}

/// `olderStatus(status)`: `{ state: "moved", to }` becomes `{ state: "waiting", on: "upstream" }`.
pub fn older_status(status: &Value) -> Value {
    if !status_is_moved(status) {
        return status.clone();
    }
    let mut out = Map::with_capacity(2);
    out.insert("state", Value::String(JsString::from("waiting")));
    out.insert("on", Value::String(JsString::from("upstream")));
    Value::Object(out)
}

fn replace_status(holder: &mut Value) {
    let Some(map) = object_mut(holder) else {
        return;
    };
    let Some(status) = map.get("status") else {
        return;
    };
    if status_is_moved(status) {
        let waiting = older_status(status);
        map.insert("status", waiting);
    }
}

/// `olderListed(thread)`: a thread (or agent) with its status read as an older client can.
fn older_listed(thread: &mut Value) {
    replace_status(thread);
}

/// `olderItem(item)`: a delegation's child status; every other item as it came.
fn older_item(item: &mut Value) {
    if field_text(item, "type").is_some_and(|kind| kind == "delegation.started") {
        replace_status(item);
    }
}

fn older_event(event: &mut Value) {
    let Some(payload) = object_field_mut(event, "payload") else {
        return;
    };
    let Some(kind) = field_text(payload, "type").map(JsString::as_str) else {
        return;
    };
    match kind {
        "thread.created" => {
            if let Some(thread) = object_field_mut(payload, "thread") {
                older_listed(thread);
            }
        }
        "thread.updated" => replace_status(payload),
        "item.created" | "item.updated" => {
            if let Some(item) = object_field_mut(payload, "item") {
                older_item(item);
            }
        }
        _ => {}
    }
}

/// `olderStatuses(message)`: the message with every moved thread status an older client can
/// read. The message is changed in place (the caller owns it); a message with no moved status
/// is left exactly as it came.
pub fn older_statuses(message: &mut Value) {
    let Some(kind) = field_text(message, "type").map(JsString::as_str) else {
        return;
    };
    match kind {
        "events" => each_in_array_field(message, "events", older_event),
        "threads.patch" => each_in_record_field(message, "threads", older_listed),
        "snapshot" => older_snapshot(message),
        "items.page" | "items.window" => each_in_array_field(message, "items", older_item),
        "turn.steps" => {
            each_in_array_field(message, "steps", |step| {
                if let Some(item) = object_field_mut(step, "item") {
                    older_item(item);
                }
            });
        }
        "turns.page" => each_in_array_field(message, "turns", older_turn),
        "thread.catchUp" => replace_status(message),
        "search.results" => {
            let Some(hits) = array_field_mut(message, "hits") else {
                return;
            };
            for hit in hits.iter_mut() {
                if field_text(hit, "status").is_some_and(|status| status == "moved") {
                    object_mut(hit)
                        .map(|map| map.insert("status", Value::String(JsString::from("waiting"))));
                }
            }
        }
        _ => {}
    }
}

fn older_snapshot(message: &mut Value) {
    let Some(view) = object_field_mut(message, "view") else {
        return;
    };
    if field_text(view, "kind").is_some_and(|kind| kind == "threads") {
        each_in_record_field(view, "threads", older_listed);
        return;
    }
    if let Some(thread) = object_field_mut(view, "thread") {
        older_listed(thread);
    }
    if let Some(Value::Object(map)) = view.get_mut("items") {
        for (_, item) in map.iter_mut() {
            older_item(item);
        }
    }
}

fn older_turn(turn: &mut Value) {
    replace_status(turn);
    each_in_array_field(turn, "subagents", older_listed);
}

fn object_mut(value: &mut Value) -> Option<&mut Map> {
    match value {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

fn object_field_mut<'a>(value: &'a mut Value, key: &str) -> Option<&'a mut Value> {
    object_mut(value)?.get_mut(key)
}

fn array_field_mut<'a>(value: &'a mut Value, key: &str) -> Option<&'a mut Vec<Value>> {
    match object_field_mut(value, key)? {
        Value::Array(items) => Some(items),
        _ => None,
    }
}

fn each_in_array_field(value: &mut Value, key: &str, change: impl Fn(&mut Value)) {
    if let Some(items) = array_field_mut(value, key) {
        for item in items.iter_mut() {
            change(item);
        }
    }
}

fn each_in_record_field(value: &mut Value, key: &str, change: impl Fn(&mut Value)) {
    if let Some(record) = object_field_mut(value, key)
        && let Value::Object(map) = record
    {
        for (_, entry) in map.iter_mut() {
            change(entry);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Value {
        ace_json::parse(text).expect("parse")
    }

    #[test]
    fn a_moved_status_reads_waiting_on_upstream() {
        let status = parse(r#"{"state":"moved","to":"machine-2"}"#);
        assert_eq!(
            ace_json::to_string(&older_status(&status)),
            r#"{"state":"waiting","on":"upstream"}"#
        );
    }

    #[test]
    fn a_status_that_is_not_moved_is_unchanged() {
        let status = parse(r#"{"state":"working"}"#);
        assert_eq!(
            ace_json::to_string(&older_status(&status)),
            r#"{"state":"working"}"#
        );
    }
}
