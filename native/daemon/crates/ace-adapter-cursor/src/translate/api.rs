// SPDX-License-Identifier: Apache-2.0
//! The binding-facing JSON API (`native-translator.ts` shell): one frame's
//! JSON in, its facts' JSON out, through one preallocated output buffer.
//! Behaviour lives in the translator; this only translates values.

use super::text::parse_json;
use super::text::{JsString, Value, units_eq, write_json};
use super::translator::CursorTranslator;

/// Fold one frame's JSON into its facts' JSON array.
pub fn translate_json(translator: &mut CursorTranslator, frame_json: &str, now_ms: i64) -> String {
    let frame = match parse_json(frame_json) {
        Ok(frame) => frame,
        // Undecodable input fences the turn, as the TypeScript's throw does.
        Err(_) => return join_values(&translator.overflowed()),
    };
    let data = frame.get("data").unwrap_or(&Value::Null);
    let checked = matches!(frame.get("checked"), Some(Value::Bool(true)));
    let seq = frame.get("seq").and_then(|seq| seq.as_i64()).unwrap_or(0);
    let channel = match frame.get("channel") {
        Some(Value::String(channel)) => channel,
        _ => JsString::empty(),
    };
    let dir = match frame.get("dir") {
        Some(Value::String(dir)) => dir,
        _ => JsString::empty(),
    };
    // TypeScript resets per-frame state before its channel guard, then
    // returns for a non-SDK frame without fencing: a non-SDK frame never
    // fences, however large. Go through the translator so its reset runs.
    if !units_eq(channel, "sdk") {
        return join_values(&translator.translate_frame(data, seq, channel, dir, now_ms));
    }
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

/// One preallocated buffer for the facts array; values serialize, never re-encoded.
fn join_values(values: &[Value]) -> String {
    let mut out = String::with_capacity(values.len() * 128 + 2);
    out.push('[');
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_json(&mut out, value);
    }
    out.push(']');
    out
}

/// Mirrors the shell's admission budgets on unadmitted frames: 1 MiB,
/// 32,768 nodes, 64 levels. Past any of them the turn fences, as the
/// TypeScript's throw does. Iterative, so deep nesting cannot overflow.
fn admission_exceeded(value: &Value) -> bool {
    let mut nodes = 0usize;
    let mut stack: Vec<(&Value, usize)> = vec![(value, 0)];
    while let Some((current, depth)) = stack.pop() {
        nodes += 1;
        if nodes > 32_768 || depth > 64 {
            return true;
        }
        match current {
            Value::Array(items) => {
                for item in items.iter() {
                    stack.push((item, depth + 1));
                }
            }
            Value::Object(entries) => {
                for (_, item) in entries.iter() {
                    stack.push((item, depth + 1));
                }
            }
            _ => {}
        }
    }
    let mut text = String::new();
    write_json(&mut text, value);
    text.len() > 1_048_576
}
