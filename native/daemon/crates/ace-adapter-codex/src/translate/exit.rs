// SPDX-License-Identifier: Apache-2.0
//! Host logging can admit this adapter diagnostic without decoding frames.

use ace_json::Value;

use super::helpers::{obj_map, str_empty};

fn utf8_len(text: &str) -> usize {
    text.len()
}

fn is_nonnegative_int(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Number(n)) => n.as_i64().is_some_and(|v| v >= 0),
        _ => false,
    }
}

/// Whether `data` is a `codex-session-exit` note, as the Zod schema checks.
pub fn is_codex_session_exit(data: &Value) -> bool {
    let map = obj_map(data);
    if str_empty(map.get("event")) != "codex-session-exit" {
        return false;
    }
    let generation = match map.get("generation") {
        Some(Value::String(s)) => s,
        _ => return false,
    };
    let units = generation.encode_utf16().count();
    if !(1..=1024).contains(&units) {
        return false;
    }
    if !matches!(map.get("deliberate"), Some(Value::Bool(_))) {
        return false;
    }
    match map.get("retirement") {
        Some(Value::Null) => {}
        Some(Value::String(s))
            if matches!(
                s.as_str(),
                "idle" | "user" | "shutdown" | "aborted" | "open_failed" | "rpc_failed"
            ) => {}
        _ => return false,
    }
    match map.get("reason") {
        Some(Value::String(s))
            if matches!(
                s.as_str(),
                "exit" | "signal" | "stopped" | "spawn-error" | "output-limit" | "detached"
            ) => {}
        _ => return false,
    }
    match map.get("code") {
        Some(Value::Null) => {}
        Some(Value::Number(n)) if n.as_i64().is_some() => {}
        _ => return false,
    }
    match map.get("signal") {
        Some(Value::Null) => {}
        Some(Value::String(s)) if s.encode_utf16().count() <= 32 => {}
        _ => return false,
    }
    if let Some(pid) = map.get("pid") {
        match pid {
            Value::Number(n) => {
                if n.as_i64().is_none_or(|v| v <= 0) {
                    return false;
                }
            }
            _ => return false,
        }
    }
    match map.get("stderrSummary") {
        Some(Value::String(s)) if s.encode_utf16().count() <= 1024 => {}
        _ => return false,
    }
    if let Some(output_drained) = map.get("outputDrained")
        && !output_drained.is_boolean()
    {
        return false;
    }
    match map.get("stderr") {
        Some(Value::String(s)) if utf8_len(s) <= 4096 => {}
        _ => return false,
    }
    let _ = is_nonnegative_int;
    true
}
