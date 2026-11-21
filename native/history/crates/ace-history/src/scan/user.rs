// SPDX-License-Identifier: Apache-2.0

//! `userPrompt` and `hasUserInput` (`packages/history-import/src/user-text.ts`).

use history_text::sanitize_user_text;
use serde_json::Value;

use crate::json::{field, has, is_true, object, present};

type Fields = serde_json::Map<String, Value>;

/// The record and its message, as the prompt rules see them.
fn parts(value: &Value) -> Option<(&Fields, &Fields)> {
    let r = object(value);
    let p = if field(r, "type").as_str() == Some("response_item") {
        object(field(r, "payload"))
    } else {
        r
    };
    let message = if has(p, "message") {
        object(field(p, "message"))
    } else {
        p
    };
    let user = field(message, "role").as_str() == Some("user")
        || field(p, "type").as_str() == Some("user");
    if !user || is_true(p, "synthetic") || is_true(p, "isMeta") || is_true(p, "isCompactSummary") {
        return None;
    }
    Some((p, message))
}

/// Native message text, independent of transport and provider storage.
pub fn user_prompt(value: &Value) -> String {
    let Some((p, message)) = parts(value) else {
        return String::new();
    };
    let content = present(message.get("content"))
        .or_else(|| present(p.get("content")))
        .or_else(|| present(p.get("text")));
    let text = match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|part| {
                object(part)
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    sanitize_user_text(&text)
}

/// A deliberate attachment is user input even when it has no caption.
pub fn has_user_input(value: &Value) -> bool {
    if !user_prompt(value).is_empty() {
        return true;
    }
    let Some((p, message)) = parts(value) else {
        return false;
    };
    let content = present(message.get("content")).or_else(|| present(p.get("content")));
    content.and_then(Value::as_array).is_some_and(|items| {
        items.iter().any(|part| {
            matches!(
                object(part).get("type").and_then(Value::as_str),
                Some("image" | "input_image" | "file")
            )
        })
    })
}
