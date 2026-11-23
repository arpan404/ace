// SPDX-License-Identifier: Apache-2.0
//! The binding-facing JSON API (`native-translator.ts` shell): one frame's
//! JSON in, its facts' JSON out, through one preallocated output buffer.
//! Behaviour lives in the translator; this only translates values.

use super::json::{J, write_json};
use super::parse::parse_json;
use super::translator::CursorTranslator;

/// Fold one frame's JSON into its facts' JSON array.
pub fn translate_json(translator: &mut CursorTranslator, frame_json: &str, now_ms: i64) -> String {
    let frame = match parse_json(frame_json) {
        Ok(frame) => frame,
        // Undecodable input fences the turn, as the TypeScript's throw does.
        Err(_) => return join_values(&translator.overflowed()),
    };
    let data = frame.get("data").unwrap_or(&J::Null);
    let checked = matches!(frame.get("checked"), Some(J::Bool(true)));
    let seq = frame
        .get("seq")
        .and_then(|seq| seq.as_int().ok())
        .unwrap_or(0);
    let channel = match frame.get("channel") {
        Some(J::Str(channel)) => channel.as_slice(),
        _ => &[],
    };
    let dir = match frame.get("dir") {
        Some(J::Str(dir)) => dir.as_slice(),
        _ => &[],
    };
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
fn join_values(values: &[J]) -> String {
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
/// TypeScript's throw does.
fn admission_exceeded(value: &J) -> bool {
    fn walk(value: &J, depth: usize, nodes: &mut usize) -> bool {
        *nodes += 1;
        if *nodes > 32_768 || depth > 64 {
            return true;
        }
        match value {
            J::Arr(items) => items.iter().any(|item| walk(item, depth + 1, nodes)),
            J::Obj(entries) => entries.iter().any(|(_, item)| walk(item, depth + 1, nodes)),
            _ => false,
        }
    }
    let mut nodes = 0;
    if walk(value, 0, &mut nodes) {
        return true;
    }
    let mut text = String::new();
    write_json(&mut text, value);
    text.len() > 1_048_576
}
