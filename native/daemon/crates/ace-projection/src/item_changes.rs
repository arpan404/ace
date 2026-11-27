// SPDX-License-Identifier: Apache-2.0
//! `changedItemId` from `packages/projection/src/item-changes.ts`: which transcript item an
//! event changed, named the way a page and a client's catch-up name it.

use ace_json::{JsString, Value};

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map.get(key),
        _ => None,
    }
}

fn field_text<'a>(value: &'a Value, key: &str) -> Option<&'a JsString> {
    match field(value, key) {
        Some(Value::String(text)) => Some(text),
        _ => None,
    }
}

/// `changedItemId(payload)`: the item an event created, updated, streamed or deleted (an
/// admitted input names `input:<command>`), or `None` for an event that changes no item.
pub fn changed_item_id(payload: &Value) -> Option<String> {
    let kind = field_text(payload, "type")?;
    match kind.as_str() {
        "item.created" | "item.updated" => field(payload, "item")
            .and_then(|item| field_text(item, "id"))
            .map(|id| id.as_str().to_owned()),
        "item.delta" | "item.deleted" => {
            field_text(payload, "itemId").map(|id| id.as_str().to_owned())
        }
        "input.admitted" => field_text(payload, "commandId")
            .filter(|command| !command.is_empty())
            .map(|command| format!("input:{}", command.as_str())),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Value {
        ace_json::parse(text).expect("parse")
    }

    #[test]
    fn an_item_event_names_its_item() {
        assert_eq!(
            changed_item_id(&parse(r#"{"type":"item.delta","itemId":"m1"}"#)).as_deref(),
            Some("m1")
        );
        assert_eq!(
            changed_item_id(&parse(r#"{"type":"item.created","item":{"id":"m2"}}"#)).as_deref(),
            Some("m2")
        );
    }

    #[test]
    fn an_admitted_input_names_its_command_and_nothing_else_changes_an_item() {
        assert_eq!(
            changed_item_id(&parse(r#"{"type":"input.admitted","commandId":"c1"}"#)).as_deref(),
            Some("input:c1")
        );
        assert_eq!(
            changed_item_id(&parse(r#"{"type":"input.admitted","commandId":""}"#)),
            None,
            "an empty id names no item"
        );
        assert_eq!(
            changed_item_id(&parse(r#"{"type":"thread.updated"}"#)),
            None
        );
    }
}
