// SPDX-License-Identifier: Apache-2.0

//! The lenient accessors native records are read through (`object`, `string`, `timestamp` in
//! `@ace/native-session`): a missing or wrongly typed field reads as absent, never as an error.

use std::sync::LazyLock;

use history_text::js;
use serde_json::{Map, Value};

static EMPTY: LazyLock<Map<String, Value>> = LazyLock::new(Map::new);

/// The value as an object, or an empty one.
pub fn object(value: &Value) -> &Map<String, Value> {
    value.as_object().unwrap_or(&EMPTY)
}

/// A field of an object, `Null` when absent.
pub fn field<'a>(map: &'a Map<String, Value>, key: &str) -> &'a Value {
    map.get(key).unwrap_or(&Value::Null)
}

/// A field as a string.
pub fn string<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key).and_then(Value::as_str)
}

/// `value ?? fallback`: JSON null is nullish too.
pub fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| !v.is_null())
}

/// A non-negative safe integer, or a date string `Date.parse` reads.
pub fn timestamp(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => {
            let f = n.as_f64()?;
            (f >= 0.0 && f.fract() == 0.0 && f <= js::MAX_SAFE_INTEGER as f64).then_some(f as i64)
        }
        Value::String(s) => js::parse_date(s).filter(|ms| (0..=js::MAX_SAFE_INTEGER).contains(ms)),
        _ => None,
    }
}

/// Whether the field is JSON `true`.
pub fn is_true(map: &Map<String, Value>, key: &str) -> bool {
    map.get(key) == Some(&Value::Bool(true))
}

/// Whether the object has the key at all (`Object.hasOwn`).
pub fn has(map: &Map<String, Value>, key: &str) -> bool {
    map.contains_key(key)
}
