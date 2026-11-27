// SPDX-License-Identifier: Apache-2.0
//! Lenient helpers for the Pi translator, mirroring `native.ts`.
//! Reads borrow the frame's validated JSON and never build value trees:
//! objects decode as maps of raw values, arrays as lists of raw values, and
//! unknown fields are ignored. Nothing here panics on provider data.

use ace_json::{JsString, Kind, Raw, RawRef};
use std::borrow::Cow;
use std::collections::HashMap;

/// An object's fields, each kept as its canonical JSON. A duplicate key keeps
/// its last value, as `JSON.parse` does. Keys stay exact `JsString`s so a lone
/// surrogate key never collides with U+FFFD the way a lossy `String` would.
pub type Fields = HashMap<JsString, Raw>;

/// An object's fields kept raw. `None` when the value is not an object.
pub fn object_fields(raw: RawRef<'_>) -> Option<Fields> {
    if raw.kind() != Kind::Object {
        return None;
    }
    let mut map = HashMap::new();
    for (key, value) in raw.entries() {
        let name = key.as_js_string()?;
        map.insert(name, value.to_raw());
    }
    Some(map)
}

/// Parse an object into its fields kept raw. `None` when the value is not an object.
pub fn parse_object(raw: &Raw) -> Option<Fields> {
    object_fields(raw.view())
}

/// The fields of a JSON text that is an object.
pub fn parse_object_text(text: &str) -> Option<Fields> {
    ace_json::parse_raw(text).ok().and_then(object_fields)
}

/// Parse an array into its items kept raw. `None` when the value is not an array.
pub fn parse_array(raw: &Raw) -> Option<Vec<Raw>> {
    let raw = raw.view();
    (raw.kind() == Kind::Array).then(|| raw.items().map(|item| item.to_raw()).collect())
}

/// Lenient string: the JSON string itself, else `None`.
pub fn raw_as_str(raw: &Raw) -> Option<String> {
    raw.view().as_str().map(Cow::into_owned)
}

/// A non-negative integer the JSON value holds exactly.
pub fn raw_as_u64(raw: &Raw) -> Option<u64> {
    raw.view().as_u64()
}

/// The JSON value as a number.
pub fn raw_as_f64(raw: &Raw) -> Option<f64> {
    raw.view().as_f64()
}

/// The `str` helper: strings pass through, everything else reads as empty.
pub fn str_of(raw: Option<&Raw>) -> String {
    match raw {
        Some(value) => raw_as_str(value).unwrap_or_default(),
        None => String::new(),
    }
}

/// Field lookup without copying: the raw value for `key`, if present.
pub fn field<'a>(map: &'a Fields, key: &str) -> Option<&'a Raw> {
    map.get(&JsString::from(key))
}

/// `str` of an object's field: missing or non-string reads as empty.
pub fn str_field(map: &Fields, key: &str) -> String {
    str_of(field(map, key))
}

/// Optional string field: `Some` only for a JSON string.
pub fn opt_string_field(map: &Fields, key: &str) -> Option<String> {
    match field(map, key) {
        Some(value) => raw_as_str(value),
        None => None,
    }
}

/// Optional bool field: `Some` only when the JSON value is a bool.
pub fn bool_field(map: &Fields, key: &str) -> Option<bool> {
    field(map, key).and_then(|value| value.view().as_bool())
}

/// Optional f64 field: `Some` only when the JSON value is a number.
pub fn number_field(map: &Fields, key: &str) -> Option<f64> {
    field(map, key).and_then(raw_as_f64)
}

/// Length of an array field: 0 when missing or not an array.
pub fn list_len(map: &Fields, key: &str) -> usize {
    match field(map, key) {
        Some(value) if value.view().kind() == Kind::Array => value.view().items().count(),
        _ => 0,
    }
}

/// Whether a method name is a blocking Pi dialog method.
pub fn is_blocking_dialog_method(method: &str) -> bool {
    matches!(method, "select" | "confirm" | "input" | "editor")
}

/// The envelope's `type`: `None` when the frame data is not an object with a string type.
pub fn envelope_type(data: &Raw) -> Option<String> {
    let map = parse_object(data)?;
    let raw = field(&map, "type")?;
    let value = raw_as_str(raw)?;
    if value.is_empty() { None } else { Some(value) }
}

/// Raw payload type: `str(obj(data).type)` or the default when empty.
pub fn raw_type_of(data: &Raw, default: &str) -> String {
    let fallback = default.to_owned();
    let map = match parse_object(data) {
        Some(map) => map,
        None => return fallback,
    };
    let value = str_field(&map, "type");
    if value.is_empty() { fallback } else { value }
}

pub use ace_json::utf16_len;

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

/// Clone a raw value without parsing it.
pub fn clone_raw(raw: &Raw) -> Option<Raw> {
    Some(raw.clone())
}

/// Extract the `item` field of a fact, used to track the last answer.
pub fn extract_item(data: &Raw) -> Option<String> {
    data.view()
        .get("item")
        .and_then(|item| item.as_str().map(Cow::into_owned))
}
