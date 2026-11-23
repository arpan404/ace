// SPDX-License-Identifier: Apache-2.0
//! A cut-off run's messages, read back from the SDK store after a restart and
//! turned back into the onDelta updates they were stored from
//! (`recovered-tail.ts`).

use serde_json::{Map, Value, json};

use super::envelope::{object, string};

fn tool_update(body: &Map<String, Value>) -> Option<Value> {
    let call_id = string(body.get("call_id")?)?;
    let name = match body.get("name") {
        Some(value) => string(value).unwrap_or("unknown"),
        None => "unknown",
    };
    let mut tool_call = Map::new();
    tool_call.insert("type".to_owned(), Value::String(name.to_owned()));
    if let Some(args) = body.get("args") {
        tool_call.insert("args".to_owned(), args.clone());
    }
    if let Some(result) = body.get("result") {
        tool_call.insert("result".to_owned(), result.clone());
    }
    Some(json!({
        "type": if body.get("status") == Some(&Value::String("running".to_owned())) {
            "tool-call-started"
        } else {
            "tool-call-completed"
        },
        "callId": call_id,
        "toolCall": tool_call,
    }))
}

/// The update a stored SDK message came from; none for bookkeeping ones.
pub fn stored_update(message: &Value) -> Option<Value> {
    let body = object(message);
    match string(body.get("type")?) {
        Some("assistant") => {
            let content = match object(body.get("message")?).get("content") {
                Some(Value::Array(content)) => content,
                _ => return None,
            };
            let mut text = String::new();
            for part in content {
                let part = object(part);
                if string(part.get("type")?) == Some("text") {
                    text.push_str(string(part.get("text")?)?);
                }
            }
            if text.is_empty() {
                None
            } else {
                Some(json!({ "type": "text-delta", "text": text }))
            }
        }
        Some("thinking") => {
            let text = match body.get("text") {
                Some(value) => string(value).unwrap_or(""),
                None => "",
            };
            if text.is_empty() {
                let mut update = Map::new();
                update.insert(
                    "type".to_owned(),
                    Value::String("thinking-completed".to_owned()),
                );
                if let Some(Value::Number(duration)) = body.get("thinking_duration_ms") {
                    update.insert(
                        "thinkingDurationMs".to_owned(),
                        Value::Number(duration.clone()),
                    );
                }
                Some(Value::Object(update))
            } else {
                Some(json!({ "type": "thinking-delta", "text": text }))
            }
        }
        Some("tool_call") => tool_update(body),
        Some("task") => {
            let text = string(body.get("text")?)?;
            Some(json!({ "type": "summary", "summary": text }))
        }
        _ => None,
    }
}

/// Why some of a recovered tail is not in the SDK's store, in plain words.
pub fn store_gap(message: &Value) -> Option<String> {
    let body = object(message);
    if string(body.get("type")?) != Some("tool_call")
        || body.get("status") == Some(&Value::String("running".to_owned()))
    {
        return None;
    }
    let truncated = object(body.get("truncated")?);
    if truncated.get("args") == Some(&Value::Bool(true))
        || truncated.get("result") == Some(&Value::Bool(true))
    {
        return Some(
            "Cursor's saved session kept only a shortened copy of some tool input or output from that time."
                .to_owned(),
        );
    }
    if string(body.get("name")?) == Some("task") {
        return Some(
            "What a subagent did step by step in that time is not in Cursor's saved session; only its result is."
                .to_owned(),
        );
    }
    None
}
