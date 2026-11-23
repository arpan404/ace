// SPDX-License-Identifier: Apache-2.0
//! The binding-facing JSON API (`native-translator.ts` shell): one frame's
//! JSON in, its facts' JSON out, through one preallocated output buffer.
//! Behaviour lives in the translator; this only translates values.

use serde_json::Value;

use super::translator::CursorTranslator;

/// Fold one frame's JSON into its facts' JSON array.
pub fn translate_json(translator: &mut CursorTranslator, frame_json: &str, now_ms: i64) -> String {
    let frame: Value = serde_json::from_str(frame_json).unwrap_or(Value::Null);
    let map = match &frame {
        Value::Object(map) => map,
        _ => return "[]".to_owned(),
    };
    let seq = map.get("seq").and_then(Value::as_i64).unwrap_or(0);
    let channel = map.get("channel").and_then(Value::as_str).unwrap_or("");
    let dir = map.get("dir").and_then(Value::as_str).unwrap_or("recv");
    let data = map.get("data").unwrap_or(&Value::Null);
    let checked = map.get("checked").and_then(Value::as_bool).unwrap_or(false);
    if !checked && admission_exceeded(data) {
        return join_values(&translator.overflowed());
    }
    join_values(&translator.translate_frame(data, seq, channel, dir, now_ms))
}

/// Facts implied by time passing, as JSON.
pub fn tick_json(translator: &mut CursorTranslator, _now_ms: i64) -> String {
    join_values(&translator.tick())
}

/// Native debug evidence kept outside the transcript, as JSON.
pub fn take_diagnostics_json(translator: &mut CursorTranslator) -> String {
    join_values(&translator.take_diagnostics())
}

/// The translator sets no deadline of its own.
pub fn next_deadline_json() -> String {
    "null".to_owned()
}

/// Mirrors the shell's admission budgets (`boundedJson`, `ProviderPayload`):
/// 1 MiB, 32,768 nodes, 64 levels. An unadmitted frame past any of them fences
/// the turn, as the TypeScript's throw does.
fn admission_exceeded(value: &Value) -> bool {
    fn walk(value: &Value, depth: usize, nodes: &mut usize) -> bool {
        *nodes += 1;
        if *nodes > 32_768 || depth > 64 {
            return true;
        }
        match value {
            Value::Array(items) => items.iter().any(|item| walk(item, depth + 1, nodes)),
            Value::Object(map) => map.values().any(|item| walk(item, depth + 1, nodes)),
            _ => false,
        }
    }
    let mut nodes = 0;
    if walk(value, 0, &mut nodes) {
        return true;
    }
    serde_json::to_string(value).is_ok_and(|text| text.len() > 1_048_576)
}

/// One preallocated buffer for the facts array; values serialize, never re-encoded.
fn join_values(values: &[Value]) -> String {
    let mut out = String::with_capacity(values.len() * 128 + 2);
    out.push('[');
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned()));
    }
    out.push(']');
    out
}
