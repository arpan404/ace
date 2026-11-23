// SPDX-License-Identifier: Apache-2.0
//! A cut-off run's messages, read back from the SDK store after a restart and
//! turned back into the onDelta updates they were stored from
//! (`recovered-tail.ts`).

use super::envelope::{is, string};
use super::text::{JsString, Value, units_eq};

fn tool_update(body: &Value) -> Option<Value> {
    let call_id = string(body.get("call_id")?)?;
    let name = match body.get("name") {
        Some(Value::String(name)) => name.clone(),
        _ => JsString::from("unknown"),
    };
    let mut tool_call = vec![(JsString::from("type"), Value::String(name))];
    if let Some(args) = body.get("args") {
        tool_call.push((JsString::from("args"), args.clone()));
    }
    if let Some(result) = body.get("result") {
        tool_call.push((JsString::from("result"), result.clone()));
    }
    Some(Value::from(vec![
        (
            JsString::from("type"),
            Value::String(JsString::from(
                if is(body.get("status").unwrap_or(&Value::Null), "running") {
                    "tool-call-started"
                } else {
                    "tool-call-completed"
                },
            )),
        ),
        (JsString::from("callId"), Value::String(call_id.clone())),
        (JsString::from("toolCall"), Value::from(tool_call)),
    ]))
}

/// The update a stored SDK message came from; none for bookkeeping ones.
pub fn stored_update(message: &Value) -> Option<Value> {
    let body = message;
    let kind = string(body.get("type")?)?;
    if units_eq(kind, "assistant") {
        let content = match body
            .get("message")
            .and_then(|message| message.get("content"))
        {
            Some(Value::Array(content)) => content,
            _ => return None,
        };
        let mut text = JsString::new();
        for part in content {
            if !is(part.get("type").unwrap_or(&Value::Null), "text") {
                continue;
            }
            if let Some(part) = string(part.get("text").unwrap_or(&Value::Null)) {
                text.push_js(part);
            }
        }
        if text.is_empty() {
            return None;
        }
        return Some(Value::from(vec![
            (
                JsString::from("type"),
                Value::String(JsString::from("text-delta")),
            ),
            (JsString::from("text"), Value::String(text)),
        ]));
    }
    if units_eq(kind, "thinking") {
        let text = match body.get("text") {
            Some(value) => string(value).unwrap_or(JsString::empty()),
            None => JsString::empty(),
        };
        if text.is_empty() {
            let mut update = vec![(
                JsString::from("type"),
                Value::String(JsString::from("thinking-completed")),
            )];
            if let Value::Number(duration) =
                body.get("thinking_duration_ms").unwrap_or(&Value::Null)
            {
                update.push((
                    JsString::from("thinkingDurationMs"),
                    Value::Number(*duration),
                ));
            }
            return Some(Value::from(update));
        }
        return Some(Value::from(vec![
            (
                JsString::from("type"),
                Value::String(JsString::from("thinking-delta")),
            ),
            (JsString::from("text"), Value::String(text.clone())),
        ]));
    }
    if units_eq(kind, "tool_call") {
        return tool_update(body);
    }
    if units_eq(kind, "task") {
        let text = string(body.get("text")?)?;
        return Some(Value::from(vec![
            (
                JsString::from("type"),
                Value::String(JsString::from("summary")),
            ),
            (JsString::from("summary"), Value::String(text.clone())),
        ]));
    }
    None
}

/// Why some of a recovered tail is not in the SDK's store, in plain words.
pub fn store_gap(message: &Value) -> Option<JsString> {
    let body = message;
    if !is(body.get("type").unwrap_or(&Value::Null), "tool_call")
        || is(body.get("status").unwrap_or(&Value::Null), "running")
    {
        return None;
    }
    let truncated = body.get("truncated").unwrap_or(&Value::Null);
    if matches!(truncated.get("args"), Some(Value::Bool(true)))
        || matches!(truncated.get("result"), Some(Value::Bool(true)))
    {
        return Some(JsString::from(
            "Cursor's saved session kept only a shortened copy of some tool input or output from that time.",
        ));
    }
    if is(body.get("name").unwrap_or(&Value::Null), "task") {
        return Some(JsString::from(
            "What a subagent did step by step in that time is not in Cursor's saved session; only its result is.",
        ));
    }
    None
}
