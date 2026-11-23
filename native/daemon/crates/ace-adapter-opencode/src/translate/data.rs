// SPDX-License-Identifier: Apache-2.0
//! The translator's dynamic JSON readers (`packages/adapter-opencode/src/data.ts`).
//! Provider frames arrive as decoded JSON; these read fields the way the
//! TypeScript helpers do: strings fall back, numbers must be finite, anything
//! else reads as the shared empty value. Nothing here copies.

use ace_adapter_api::util::record::{NativeRecord, native_record};
use serde::Serializer;
use serde_json::{Map, Value};

/// The shared empty value non-values read as; returned by borrow, never copied.
pub static NULL: Value = Value::Null;

/// Read a decoded provider value as its fields, or the empty object.
pub fn fields(value: &Value) -> NativeRecord<'_> {
    native_record(value)
}

/// The value's field, or null when missing.
pub fn get<'a>(map: &'a Map<String, Value>, key: &str) -> &'a Value {
    match map.get(key) {
        Some(value) => value,
        None => &NULL,
    }
}

/// The value as a string, or the empty fallback (`string` in TypeScript).
pub fn s(value: &Value) -> &str {
    match value {
        Value::String(text) => text,
        _ => "",
    }
}

/// A field as a string, or the empty fallback.
pub fn s_in<'a>(map: &'a Map<String, Value>, key: &str) -> &'a str {
    s(get(map, key))
}

/// A field as a string, or the caller's fallback (nested `string(x, fb)`).
pub fn s_in_fb<'a>(map: &'a Map<String, Value>, key: &str, fallback: &'a str) -> &'a str {
    match map.get(key) {
        Some(Value::String(text)) => text,
        _ => fallback,
    }
}

/// The value as a finite number, or zero (`number` in TypeScript).
pub fn n(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// A field as a finite number, or zero.
pub fn n_in(map: &Map<String, Value>, key: &str) -> f64 {
    n(get(map, key))
}

/// A field as a finite number, or the caller's fallback.
pub fn n_in_fb(map: &Map<String, Value>, key: &str, fallback: f64) -> f64 {
    match map.get(key) {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(fallback),
        _ => fallback,
    }
}

/// The value as an array, or the empty one (`array` in TypeScript).
pub fn arr(value: &Value) -> &[Value] {
    match value {
        Value::Array(items) => items,
        _ => &[],
    }
}

/// A field as an array, or the empty one.
pub fn arr_in<'a>(map: &'a Map<String, Value>, key: &str) -> &'a [Value] {
    arr(get(map, key))
}

/// Format a finite JSON number the way `JSON.stringify` does: integral values
/// print without a decimal point, so fact bytes match the TypeScript exactly.
pub fn num_str(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
        (value as i64).to_string()
    } else {
        value.to_string()
    }
}

/// A JSON number that serializes the way `JSON.stringify` prints it.
pub struct Num(pub f64);

impl serde::Serialize for Num {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let value = self.0;
        if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
            serializer.serialize_i64(value as i64)
        } else {
            serializer.serialize_f64(value)
        }
    }
}

/// A raw payload's data: either the frame's original encoding, kept verbatim,
/// or sanitized evidence, serialized without re-encoding the verbatim side.
pub enum Datum<'a> {
    /// The frame's redacted encoding, cut from it as produced.
    Verbatim(&'a str),
    /// Sanitized evidence, owned after redaction.
    Owned(Value),
}

impl serde::Serialize for Datum<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Datum::Verbatim(text) => {
                match serde_json::from_str::<Box<serde_json::value::RawValue>>(text) {
                    Ok(raw) => raw.serialize(serializer),
                    Err(_) => serializer.serialize_none(),
                }
            }
            Datum::Owned(value) => value.serialize(serializer),
        }
    }
}

/// A native debug payload kept outside the transcript.
#[derive(serde::Serialize)]
pub struct RawPayload<'a> {
    #[serde(rename = "type")]
    pub typ: &'a str,
    pub data: Datum<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<&'a str>,
}

use crate::translate::redaction::sanitize;

/// A raw payload over sanitized evidence (`raw` in TypeScript).
pub fn raw<'a>(typ: &'a str, evidence: &Value, name: Option<&'a str>) -> RawPayload<'a> {
    RawPayload {
        typ,
        data: Datum::Owned(sanitize(evidence, &[]).into_owned()),
        name,
    }
}

/// Whether a decoded value counts as present (`if (value)` in TypeScript).
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(hit) => *hit,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// A failed turn whose upstream provider says, in its own words, that the
/// account is out of quota or credit. Prose only names the failure for
/// display; it never holds queued messages.
pub fn failure_code(message: &str) -> Option<&'static str> {
    let lower = message.to_lowercase();
    let text = lower.as_str();
    if text.contains("insufficient_quota")
        || text.contains("insufficient quota")
        || text.contains("exceeded your current quota")
        || text.contains("usage limit")
        || text.contains("out of usage")
        || text.contains("credit balance is too low")
        || text.contains("insufficient credits")
    {
        Some("usage_limit")
    } else {
        None
    }
}

/// OpenCode retrying a request, throttled ones included, waits; anything else
/// is upstream.
pub fn retry_reason(message: &str) -> &'static str {
    if message.contains("ECONN")
        || message.contains("ENOTFOUND")
        || message.contains("network")
        || message.contains("socket")
        || message.contains("fetch failed")
        || has_timeout_out(message)
    {
        "network"
    } else {
        "upstream"
    }
}

/// The `timed? ?out` alternative of the TypeScript retry pattern, matched
/// case-sensitively: `time` plus an optional `d`, an optional space, `out`.
fn has_timeout_out(message: &str) -> bool {
    let bytes = message.as_bytes();
    let mut index = 0;
    while index + 4 <= bytes.len() {
        if &bytes[index..index + 4] == b"time" {
            let mut next = index + 4;
            if bytes.get(next) == Some(&b'd') {
                next += 1;
            }
            if bytes.get(next) == Some(&b' ') {
                next += 1;
            }
            if bytes.get(next..next + 3) == Some(b"out".as_slice()) {
                return true;
            }
        }
        index += 1;
    }
    false
}

/// Length in UTF-16 code units, like the TypeScript `length` checks.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Truncate to a number of UTF-16 code units, like `String.slice`, without
/// splitting a character.
pub fn slice_units(text: &str, max: usize) -> &str {
    if text.encode_utf16().count() <= max {
        return text;
    }
    let mut units = 0;
    let mut end = 0;
    for (index, ch) in text.char_indices() {
        units += ch.len_utf16();
        if units > max {
            break;
        }
        end = index + ch.len_utf8();
    }
    &text[..end]
}
