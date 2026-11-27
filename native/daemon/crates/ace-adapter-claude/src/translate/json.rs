// SPDX-License-Identifier: Apache-2.0
//! JSON readers for the redacted capture (the port of `native.ts`).
//! Translators read native fields through these on every frame without
//! copying the whole value; unknown shapes read as empty, never fatal.

use ace_json::{Map, Value};
use std::sync::LazyLock;

static EMPTY_MAP: LazyLock<Map> = LazyLock::new(Map::new);
static EMPTY_LIST: LazyLock<Vec<Value>> = LazyLock::new(Vec::new);

/// The value's map if it is a JSON object, otherwise the shared empty one.
pub fn object(value: &Value) -> &Map {
    match value {
        Value::Object(map) => map,
        _ => &EMPTY_MAP,
    }
}

/// The value if it is a string, otherwise the fallback.
pub fn string(value: &Value, fallback: &str) -> String {
    match value {
        Value::String(s) => s.to_string(),
        _ => fallback.to_owned(),
    }
}

/// The value's string, or empty.
pub fn str_of(value: &Value) -> String {
    match value {
        Value::String(s) => s.to_string(),
        _ => String::new(),
    }
}

/// The value if it is an array, otherwise an empty slice.
pub fn list(value: &Value) -> &[Value] {
    match value {
        Value::Array(items) => items,
        _ => &EMPTY_LIST,
    }
}

/// A non-negative finite number, or zero (the TypeScript `number` helper:
/// non-numbers, negatives and non-finite numbers read as zero).
pub fn number(value: &Value) -> f64 {
    match value {
        Value::Number(n) => n
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.0)
            .unwrap_or(0.0),
        _ => 0.0,
    }
}

/// Text of a value: a string, or the joined text of its blocks.
pub fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.to_string(),
        Value::Array(items) => {
            let mut out = String::new();
            for item in items {
                if let Some(Value::String(t)) = object(item).get("text") {
                    out.push_str(t);
                }
            }
            out
        }
        _ => String::new(),
    }
}

/// Field access on an object value.
pub fn get<'a>(value: &'a Value, key: &str) -> &'a Value {
    object(value).get(key).unwrap_or(&Value::Null)
}

/// A raw payload keeping the provider's encoding verbatim.
pub fn raw(data: &Value) -> Value {
    raw_named(data, None)
}

/// A raw payload with a native tool name.
pub fn raw_named(data: &Value, name: Option<&str>) -> Value {
    let obj = object(data);
    let subtype = obj
        .get("subtype")
        .and_then(|v| v.as_str())
        .unwrap_or("claude");
    let kind = obj.get("type").and_then(|v| v.as_str()).unwrap_or(subtype);
    let mut map = Map::with_capacity(3);
    map.insert("type".to_owned(), Value::from(kind.to_owned()));
    if let Some(n) = name {
        map.insert("name".to_owned(), Value::from(n.to_owned()));
    }
    map.insert("data".to_owned(), data.clone());
    Value::Object(map)
}
