// SPDX-License-Identifier: Apache-2.0
//! The one JSON doorway of the reducer (E4). Everything here parses or
//! emits through `serde_json` with `preserve_order`, so maps iterate in
//! insertion order exactly like the TypeScript records they mirror. When the
//! shared `ace-json` crate lands, only this module changes: no other module
//! parses, serializes, or walks untrusted nesting on its own.
//!
//! Rules this module enforces for every caller:
//! - parsing runs under `stacker`, so deeply nested provider data fails as a
//!   value error downstream, never as a stack overflow;
//! - no caller recurses over untrusted nesting: traversal here is iterative
//!   with an explicit depth budget (the TypeScript caps diagnostic capture at
//!   depth 100);
//! - opaque payloads are borrowed as `&RawValue` or owned as
//!   `Box<RawValue>`, never re-encoded.

use serde::Deserialize as _;
use serde_json::value::RawValue;

/// JSON values as the fold sees them. Transient only: state structs own
/// typed fields or `Box<RawValue>`, never these trees.
pub type Json = serde_json::Value;
/// Insertion-ordered objects, like the TypeScript records they mirror.
pub type Map = serde_json::Map<String, serde_json::Value>;

/// The diagnostic capture depth of `diagnosticData` in `diagnostics.ts`.
pub const DIAGNOSTIC_DEPTH_LIMIT: u32 = 100;

/// Serde helpers that read integers the way `z.number().int()` does:
// any finite JSON number with no fractional part counts, including integral
// floats like `1e2` which plain `i64` deserialization would refuse.
pub mod de {
    use serde::{Deserialize, Deserializer};

    /// A required integer field.
    pub fn i64<'de, D>(deserializer: D) -> Result<i64, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        super::as_integer(Some(&value)).ok_or_else(|| serde::de::Error::custom("expected an integer"))
    }

    /// An optional integer field: missing and `null` both read absent.
    pub fn opt_i64<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Option::<serde_json::Value>::deserialize(deserializer)?;
        match value {
            None | Some(serde_json::Value::Null) => Ok(None),
            Some(value) => super::as_integer(Some(&value))
                .map(Some)
                .ok_or_else(|| serde::de::Error::custom("expected an integer")),
        }
    }

    /// An integer array whose elements read like `z.number().int()`.
    pub fn vec_i64<'de, D>(deserializer: D) -> Result<Vec<i64>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let values = Vec::<serde_json::Value>::deserialize(deserializer)?;
        values
            .iter()
            .map(|value| {
                crate::json_io::as_integer(Some(&value))
                    .ok_or_else(|| serde::de::Error::custom("expected an integer"))
            })
            .collect()
    }
}

/// Re-exported for field attributes across the crate.
pub use de::{i64 as de_i64, opt_i64 as de_opt_i64, vec_i64 as de_vec_i64};

/// A field that distinguishes missing from explicit `null`, like
/// `PermissionMode.nullable().optional()`: missing reads `Missing` (the key
/// stays omitted), explicit `null` reads `Null` (the key serializes null).
#[derive(Debug, Clone, PartialEq)]
pub enum Maybe<T> {
    /// The key was absent.
    Missing,
    /// The key was explicitly `null`.
    Null,
    /// The key carried a value.
    Value(T),
}

impl<T> Maybe<T> {
    /// Whether the key was absent and stays omitted.
    pub fn is_missing(&self) -> bool {
        matches!(self, Self::Missing)
    }

    /// The value, when the key carried one.
    pub fn value(self) -> Option<T> {
        match self {
            Self::Value(value) => Some(value),
            _ => None,
        }
    }
}

impl<T> Default for Maybe<T> {
    fn default() -> Self {
        Self::Missing
    }
}

impl<T> Maybe<T> {
    /// Read a missing, null, or valued field.
    pub fn deserialize<'de, D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
        T: serde::de::DeserializeOwned,
    {
        let value = Option::<serde_json::Value>::deserialize(deserializer)?;
        match value {
            None => Ok(Self::Missing),
            Some(serde_json::Value::Null) => Ok(Self::Null),
            Some(value) => serde_json::from_value(value)
                .map(Self::Value)
                .map_err(serde::de::Error::custom),
        }
    }

    /// Read a missing, null, or valued integer the way `z.number().int()` does.
    pub fn deserialize_int<'de, D>(deserializer: D) -> Result<Maybe<i64>, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = Option::<serde_json::Value>::deserialize(deserializer)?;
        match value {
            None => Ok(Maybe::Missing),
            Some(serde_json::Value::Null) => Ok(Maybe::Null),
            Some(value) => crate::json_io::as_integer(Some(&value))
                .map(Maybe::Value)
                .ok_or_else(|| serde::de::Error::custom("expected an integer")),
        }
    }

    /// Write a missing field as omitted, `null` as null.
    pub fn serialize<S>(value: &Self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
        T: serde::Serialize,
    {
        match value {
            Self::Missing => serializer.serialize_none(),
            Self::Null => serializer.serialize_none(),
            Self::Value(inner) => serializer.serialize_some(inner),
        }
    }
}

/// A JSON number the TypeScript reads as an integer (`z.number().int()`:
// any finite value with no fractional part counts). Missing and `null`
// never count.
pub fn as_integer(value: Option<&Json>) -> Option<i64> {
    match value? {
        Json::Number(number) => {
            if let Some(int) = number.as_i64() {
                return Some(int);
            }
            number.as_f64().and_then(|float| {
                if float.fract() == 0.0 && float >= i64::MIN as f64 && float <= i64::MAX as f64 {
                    Some(float as i64)
                } else {
                    None
                }
            })
        }
        _ => None,
    }
}

/// A non-negative safe integer, the shape of every timestamp and count.
pub fn as_count(value: Option<&Json>) -> Option<i64> {
    as_integer(value).filter(|int| *int >= 0)
}

/// Parse untrusted JSON (a fact, a draft, a restored state) without a
/// recursion limit, on a grown stack so hostile nesting is an error.
pub fn parse_untrusted(text: &str) -> Result<Json, crate::error::CoreError> {
    stacker::maybe_grow(32 * 1024, 8 * 1024 * 1024, || {
        let mut de = serde_json::Deserializer::from_str(text);
        de.disable_recursion_limit();
        serde::de::Deserialize::deserialize(&mut de)
            .map_err(crate::error::CoreError::invalid_json)
    })
}

/// Borrow an opaque payload straight from its JSON text, never re-encoded.
pub fn raw_from(text: &str) -> Result<Box<RawValue>, crate::error::CoreError> {
    serde_json::from_str(text).map_err(crate::error::CoreError::invalid_json)
}

/// Serialize into the caller's reused buffer: one output buffer per call.
pub fn write_json(
    buffer: &mut Vec<u8>,
    value: &impl serde::Serialize,
) -> Result<(), crate::error::CoreError> {
    serde_json::to_writer(&mut *buffer, value).map_err(crate::error::CoreError::invalid_json_string)
}

/// Render a value the way `JSON.stringify` field comparison does in
/// `changeAgent`: canonical for values this crate builds itself.
pub fn canonical(value: &Json) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned())
}

/// Field-by-field equality that ignores object key order, like the
/// TypeScript `equal` in `status.ts`. Iterative: the explicit stack stands
/// in for recursion, so untrusted nesting can never overflow the stack.
pub fn json_equal(left: &Json, right: &Json) -> bool {
    if left == right {
        return true;
    }
    let mut stack = vec![(left, right)];
    while let Some((left, right)) = stack.pop() {
        if left == right {
            continue;
        }
        match (left, right) {
            (Json::Object(left_map), Json::Object(right_map)) => {
                let mut left_len = 0;
                for (key, left_value) in left_map.iter() {
                    if *left_value == Json::Null {
                        continue;
                    }
                    left_len += 1;
                    match right_map.get(key) {
                        Some(right_value) if right_value != &Json::Null => {
                            stack.push((left_value, right_value));
                        }
                        _ => return false,
                    }
                }
                let right_len = right_map.values().filter(|value| **value != Json::Null).count();
                if left_len != right_len {
                    return false;
                }
            }
            (Json::Array(left_items), Json::Array(right_items)) => {
                if left_items.len() != right_items.len() {
                    return false;
                }
                for (left_item, right_item) in left_items.iter().zip(right_items.iter()) {
                    stack.push((left_item, right_item));
                }
            }
            _ => return false,
        }
    }
    true
}

/// Preserve a fact verbatim for a rejection notice, describing values JSON
/// cannot represent, exactly like `diagnosticData`. Iterative: a work stack
/// drives the walk and a value stack reassembles containers in order, so the
/// walk never recurses and containers deeper than `DIAGNOSTIC_DEPTH_LIMIT`
/// become `{ unsupported: "excessive nesting" }`.
pub fn diagnostic_data(value: &Json) -> Json {
    enum Todo<'a> {
        Visit(&'a Json, u32),
        CollectArray(usize),
        CollectObject(Vec<String>),
    }
    let mut todo = vec![Todo::Visit(value, 0)];
    let mut values: Vec<Json> = Vec::new();
    while let Some(next) = todo.pop() {
        match next {
            Todo::Visit(current, depth) => {
                if depth > DIAGNOSTIC_DEPTH_LIMIT {
                    values.push(unsupported("excessive nesting"));
                    continue;
                }
                match current {
                    Json::Null | Json::Bool(_) | Json::String(_) | Json::Number(_) => {
                        values.push(current.clone());
                    }
                    Json::Array(items) => {
                        todo.push(Todo::CollectArray(items.len()));
                        for item in items.iter().rev() {
                            todo.push(Todo::Visit(item, depth + 1));
                        }
                    }
                    Json::Object(map) => {
                        let keys: Vec<String> = map.keys().cloned().collect();
                        todo.push(Todo::CollectObject(keys));
                        for item in map.values().rev() {
                            todo.push(Todo::Visit(item, depth + 1));
                        }
                    }
                }
            }
            Todo::CollectArray(len) => {
                let mut out = Vec::with_capacity(len);
                for _ in 0..len {
                    match values.pop() {
                        Some(item) => out.push(item),
                        None => break,
                    }
                }
                out.reverse();
                values.push(Json::Array(out));
            }
            Todo::CollectObject(keys) => {
                let mut out = Map::with_capacity(keys.len());
                let mut taken = Vec::with_capacity(keys.len());
                for _ in 0..keys.len() {
                    match values.pop() {
                        Some(item) => taken.push(item),
                        None => break,
                    }
                }
                taken.reverse();
                for (key, item) in keys.into_iter().zip(taken.into_iter()) {
                    out.insert(key, item);
                }
                values.push(Json::Object(out));
            }
        }
    }
    values.pop().unwrap_or(Json::Null)
}

fn unsupported(reason: &str) -> Json {
    Json::Object(Map::from_iter([(
        "unsupported".to_owned(),
        Json::String(reason.to_owned()),
    )]))
}
