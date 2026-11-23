// SPDX-License-Identifier: Apache-2.0
//! Lenient helpers for the Pi translator, mirroring `native.ts`.
//! All reads borrow `&RawValue` and never build `serde_json::Value` trees:
//! objects decode as maps of raw values, arrays as lists of raw values, and
//! unknown fields are ignored. Nothing here panics on provider data.

use serde_json::value::RawValue;
use std::collections::HashMap;

/// Parse an object into its fields kept raw. `None` when the value is not an object.
pub fn parse_object(raw: &RawValue) -> Option<HashMap<String, Box<RawValue>>> {
    serde_json::from_str::<HashMap<String, Box<RawValue>>>(raw.get()).ok()
}

/// Parse an array into its items kept raw. `None` when the value is not an array.
pub fn parse_array(raw: &RawValue) -> Option<Vec<Box<RawValue>>> {
    serde_json::from_str::<Vec<Box<RawValue>>>(raw.get()).ok()
}

/// Lenient string: the JSON string itself, else empty (mirrors `str`).
pub fn raw_as_str(raw: &RawValue) -> Option<String> {
    serde_json::from_str::<String>(raw.get()).ok()
}

/// The `str` helper: strings pass through, everything else reads as empty.
pub fn str_of(raw: Option<&RawValue>) -> String {
    match raw {
        Some(value) => raw_as_str(value).unwrap_or_default(),
        None => String::new(),
    }
}

/// Field lookup without copying: the raw value for `key`, if present.
pub fn field<'a>(map: &'a HashMap<String, Box<RawValue>>, key: &str) -> Option<&'a RawValue> {
    map.get(key).map(AsRef::as_ref)
}

/// `str` of an object's field: missing or non-string reads as empty.
pub fn str_field(map: &HashMap<String, Box<RawValue>>, key: &str) -> String {
    str_of(field(map, key))
}

/// Optional string field: `Some` only for a non-empty JSON string.
pub fn opt_string_field(map: &HashMap<String, Box<RawValue>>, key: &str) -> Option<String> {
    match field(map, key) {
        Some(value) => raw_as_str(value),
        None => None,
    }
}

/// Optional bool field: `Some` only when the JSON value is a bool.
pub fn bool_field(map: &HashMap<String, Box<RawValue>>, key: &str) -> Option<bool> {
    match field(map, key) {
        Some(value) => serde_json::from_str::<bool>(value.get()).ok(),
        None => None,
    }
}

/// Optional f64 field: `Some` only when the JSON value is a number.
pub fn number_field(map: &HashMap<String, Box<RawValue>>, key: &str) -> Option<f64> {
    match field(map, key) {
        Some(value) => serde_json::from_str::<f64>(value.get()).ok(),
        None => None,
    }
}

/// Length of an array field: 0 when missing or not an array.
pub fn list_len(map: &HashMap<String, Box<RawValue>>, key: &str) -> usize {
    match field(map, key) {
        Some(value) => parse_array(value)
            .map(|items| items.len())
            .unwrap_or_default(),
        None => 0,
    }
}

/// Whether a method name is a blocking Pi dialog method.
pub fn is_blocking_dialog_method(method: &str) -> bool {
    matches!(method, "select" | "confirm" | "input" | "editor")
}

/// The envelope's `type`: `None` when the frame data is not an object with a string type.
pub fn envelope_type(data: &RawValue) -> Option<String> {
    let map = parse_object(data)?;
    let raw = field(&map, "type")?;
    let value = raw_as_str(raw)?;
    if value.is_empty() { None } else { Some(value) }
}

/// Raw payload type: `str(obj(data).type)` or the default when empty.
pub fn raw_type_of(data: &RawValue, default: &str) -> String {
    let fallback = default.to_owned();
    let map = match parse_object(data) {
        Some(map) => map,
        None => return fallback,
    };
    let value = str_field(&map, "type");
    if value.is_empty() { fallback } else { value }
}

/// UTF-16 code-unit length, matching JavaScript `string.length`.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Map a UTF-16 offset into a byte index at a character boundary.
/// Offsets inside a surrogate pair round up so the result stays valid UTF-8.
pub fn utf16_to_byte_index(text: &str, utf16_offset: usize) -> usize {
    let mut units = 0_usize;
    for (byte, ch) in text.char_indices() {
        if units >= utf16_offset {
            return byte;
        }
        units += ch.len_utf16();
    }
    text.len()
}

/// Slice by UTF-16 offsets, rounding split surrogates up to a boundary.
pub fn utf16_slice(text: &str, start_units: usize, end_units: usize) -> &str {
    let start = utf16_to_byte_index(text, start_units);
    let end = utf16_to_byte_index(text, end_units.min(utf16_len(text)));
    if start >= end || start >= text.len() {
        return "";
    }
    text.get(start..end).unwrap_or_default()
}

/// The bare name of any spelling of an ace tool, mirroring `bareToolName`.
pub fn bare_tool_name(name: &str) -> &str {
    let mut bare = name;
    if let Some(rest) = bare.strip_prefix("mcp__ace__") {
        bare = rest;
    }
    while let Some(rest) = bare.strip_prefix("ace_") {
        bare = rest;
    }
    bare
}

/// Clone a raw value without parsing it; `None` only on allocation failure.
pub fn clone_raw(raw: &RawValue) -> Option<Box<RawValue>> {
    serde_json::from_str::<Box<RawValue>>(raw.get()).ok()
}

/// Extract the `item` field of a fact, used to track the last answer.
pub fn extract_item(data: &RawValue) -> Option<String> {
    let map: HashMap<String, Box<RawValue>> = serde_json::from_str(data.get()).ok()?;
    let raw = map.get("item")?;
    raw_as_str(raw.as_ref())
}
