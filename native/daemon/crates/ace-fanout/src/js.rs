// SPDX-License-Identifier: Apache-2.0
//! Helpers over `ace_json::Value` that read like the JavaScript they port: `value.type`,
//! `Array.isArray`, `typeof` checks, and JavaScript's `String.prototype.trim`.

use ace_json::{Array, JsString, Map, Value};

/// `typeof value === "object" && value !== null`, minus arrays (`Array.isArray`).
pub(crate) fn object(value: &Value) -> Option<&Map> {
    match value {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// `Array.isArray(value)`.
pub(crate) fn array(value: &Value) -> Option<&Array> {
    match value {
        Value::Array(items) => Some(items),
        _ => None,
    }
}

/// `typeof value === "string"`.
pub(crate) fn string(value: &Value) -> Option<&JsString> {
    match value {
        Value::String(text) => Some(text),
        _ => None,
    }
}

/// `value === true`.
pub(crate) fn truth(value: &Value) -> bool {
    matches!(value, Value::Bool(true))
}

/// `typeof value === "number"`.
pub(crate) fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(seen) => Some(seen.value()),
        _ => None,
    }
}

/// `value[key]`.
pub(crate) fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    object(value)?.get(key)
}

/// `value[key]` when it is a string.
pub(crate) fn field_text<'a>(value: &'a Value, key: &str) -> Option<&'a JsString> {
    string(field(value, key)?)
}

/// `value[key] === true`.
pub(crate) fn field_truth(value: &Value, key: &str) -> bool {
    field(value, key).is_some_and(truth)
}

/// `Array.isArray(value[key]) ? value[key] : []`.
pub(crate) fn field_array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    field(value, key).and_then(array).map_or(&[], |items| items)
}

/// `JSON.stringify` is not involved: this is `String.prototype.trim`, which removes
/// `WhiteSpace` and `LineTerminator` (U+FEFF included; Rust's `str::trim` leaves it).
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000a}'
            | '\u{000b}'
            | '\u{000c}'
            | '\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
