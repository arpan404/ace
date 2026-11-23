// SPDX-License-Identifier: Apache-2.0
//! The Cursor translator's JSON vocabulary, all of it ace-json's: values with JavaScript's
//! semantics, strings as JavaScript strings (counted and sliced in UTF-16 code units, lone
//! surrogates kept). A decode failure fences the turn, like the TypeScript's catch-all.

pub(crate) use ace_json::{JsString, Map, Value};

use super::{BudgetError, BudgetResult};

/// Whether a JavaScript string equals an ASCII-or-other literal.
pub(crate) fn units_eq(left: &JsString, right: &str) -> bool {
    left == right
}

pub(crate) fn is_high(unit: u16) -> bool {
    (0xd800..0xdc00).contains(&unit)
}

pub(crate) fn is_low(unit: u16) -> bool {
    (0xdc00..0xe000).contains(&unit)
}

/// `JSON.parse`; a syntax error fences the turn.
pub(crate) fn parse_json(text: &str) -> BudgetResult<Value> {
    ace_json::parse(text).map_err(|_| BudgetError::Exceeded)
}

/// Append `JSON.stringify(value)`.
pub(crate) fn write_json(out: &mut String, value: &Value) {
    ace_json::write_value(out, value);
}

/// The bytes of `JSON.stringify(value)`.
pub(crate) fn json_bytes(value: &Value) -> usize {
    ace_json::to_string(value).len()
}

/// `target[key] = value` on an object; anything else is left as is.
pub(crate) fn set(target: &mut Value, key: &str, value: Value) {
    if let Value::Object(map) = target {
        map.insert(key, value);
    }
}
