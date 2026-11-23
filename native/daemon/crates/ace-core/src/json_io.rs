// SPDX-License-Identifier: Apache-2.0
//! The one JSON doorway of the reducer (E4). Transient trees and opaque
//! payloads go through `ace-json` with JavaScript's semantics, so maps
//! iterate in insertion order exactly like the TypeScript records they
//! mirror. Typed facts and states still deserialize through serde (all
//! derives); the doorway parses and emits via ace-json, and typed decoding
//! bridges via canonical text until the Value deserializer lands.
//!
//! Rules this module enforces for every caller:
//! - parsing uses `ace-json` (iterative, no recursion, no stack growth),
//!   so deeply nested provider data fails as a value error downstream,
//!   never as a stack overflow;
//! - no caller recurses over untrusted nesting: traversal here is iterative
//!   with an explicit depth budget (the TypeScript caps diagnostic capture at
//!   depth 100);
//! - opaque payloads are owned as `ace_json::Raw` (canonical text, spliced
//!   verbatim), never re-encoded.

/// JSON values as the fold sees them. Transient only: state structs own
/// typed fields or `ace_json::Raw`, never these trees.
pub type Json = ace_json::Value;
/// Insertion-ordered objects, like the TypeScript records they mirror.
pub type Map = ace_json::Map;

/// The diagnostic capture depth of `diagnosticData` in `diagnostics.ts`.
pub const DIAGNOSTIC_DEPTH_LIMIT: u32 = 100;

/// Serde helpers that read integers the way `z.number().int()` does:
// any finite JSON number with no fractional part counts, including integral
// floats like `1e2` which plain `i64` deserialization would refuse.
//
// Visitor-based so they work with any deserializer (serde_json today,
// ace-json's Value deserializer tomorrow): no intermediate Value tree.
pub mod de {
    use serde::{Deserializer, de::Visitor};

    struct I64;
    struct OptI64;
    struct VecI64;

    /// Parse an integer the way `z.number().int()` does.
    fn as_int<E>(value: f64) -> Result<i64, E>
    where
        E: serde::de::Error,
    {
        if value.fract() == 0.0 && value >= i64::MIN as f64 && value <= i64::MAX as f64 {
            Ok(value as i64)
        } else {
            Err(E::custom("expected an integer"))
        }
    }

    impl Visitor<'_> for I64 {
        type Value = i64;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("an integer")
        }
        fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<i64, E> {
            Ok(value)
        }
        fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<i64, E> {
            i64::try_from(value).map_err(|_| E::custom("expected an integer"))
        }
        fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<i64, E> {
            as_int(value)
        }
    }

    impl<'de> Visitor<'de> for OptI64 {
        type Value = Option<i64>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("an optional integer")
        }
        fn visit_none<E: serde::de::Error>(self) -> Result<Option<i64>, E> {
            Ok(None)
        }
        fn visit_unit<E: serde::de::Error>(self) -> Result<Option<i64>, E> {
            Ok(None)
        }
        fn visit_some<D>(self, deserializer: D) -> Result<Option<i64>, D::Error>
        where
            D: Deserializer<'de>,
        {
            deserializer.deserialize_any(I64).map(Some)
        }
    }

    impl<'a> Visitor<'a> for VecI64 {
        type Value = Vec<i64>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("an integer array")
        }
        fn visit_seq<S>(self, mut seq: S) -> Result<Vec<i64>, S::Error>
        where
            S: serde::de::SeqAccess<'a>,
        {
            let mut out = Vec::with_capacity(seq.size_hint().unwrap_or(0));
            while let Some(item) = seq.next_element_seed(IntSeed)? {
                out.push(item);
            }
            Ok(out)
        }
    }

    struct IntSeed;

    impl<'de> serde::de::DeserializeSeed<'de> for IntSeed {
        type Value = i64;
        fn deserialize<D>(self, deserializer: D) -> Result<i64, D::Error>
        where
            D: Deserializer<'de>,
        {
            deserializer.deserialize_any(I64)
        }
    }

    /// A required integer field.
    pub fn i64<'de, D>(deserializer: D) -> Result<i64, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(I64)
    }

    /// An optional integer field: missing and `null` both read absent.
    pub fn opt_i64<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_option(OptI64)
    }

    /// An integer array whose elements read like `z.number().int()`.
    pub fn vec_i64<'de, D>(deserializer: D) -> Result<Vec<i64>, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_seq(VecI64)
    }
}

/// Re-exported for field attributes across the crate.
pub use de::{i64 as de_i64, opt_i64 as de_opt_i64, vec_i64 as de_vec_i64};

/// A field that distinguishes missing from explicit `null`, like
/// `PermissionMode.nullable().optional()`: missing reads `Missing` (the key
/// stays omitted), explicit `null` reads `Null` (the key serializes null).
#[derive(Debug, Clone, PartialEq, Default)]
pub enum Maybe<T> {
    /// The key was absent.
    #[default]
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

impl<T> Maybe<T> {
    /// Read a missing, null, or valued field. Missing is handled by
    /// `#[serde(default)]` (never reaching here); explicit `null` reads
    /// `Missing` today, preserving the facade's long-standing shape.
    pub fn deserialize<'de, D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
        T: serde::de::Deserialize<'de>,
    {
        use serde::Deserialize as _;
        Ok(match Option::<T>::deserialize(deserializer)? {
            None => Self::Missing,
            Some(value) => Self::Value(value),
        })
    }

    /// Read a missing, null, or valued integer the way `z.number().int()` does.
    pub fn deserialize_int<'de, D>(deserializer: D) -> Result<Maybe<i64>, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(match crate::json_io::de::opt_i64(deserializer)? {
            None => Maybe::Missing,
            Some(value) => Maybe::Value(value),
        })
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

/// Deserialize a verbatim payload (`ace_json::Raw`) through a serde
/// deserializer (typed decoding still runs on serde_json): via `Value`
/// (which survives the buffering internally tagged enums do), then keep its
/// canonical ace-json form. Inputs are canonical, so re-encoding is verbatim.
pub fn deserialize_raw<'de, D>(deserializer: D) -> Result<ace_json::Raw, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize as _;
    let value = serde_json::Value::deserialize(deserializer).map_err(serde::de::Error::custom)?;
    let text = serde_json::to_string(&value).map_err(serde::de::Error::custom)?;
    ace_json::Raw::from_json(&text).map_err(serde::de::Error::custom)
}

/// Serialize a verbatim payload: ace-json splices it, serde_json would
/// stringify it, so this only runs under ace-json (all emits).
pub fn serialize_raw<S>(raw: &ace_json::Raw, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    use serde::Serialize as _;
    raw.serialize(serializer)
}

/// Deserialize an optional verbatim payload.
pub fn deserialize_opt_raw<'de, D>(deserializer: D) -> Result<Option<ace_json::Raw>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize as _;
    Ok(
        match Option::<serde_json::Value>::deserialize(deserializer)
            .map_err(serde::de::Error::custom)?
        {
            None => None,
            Some(serde_json::Value::Null) => None,
            Some(value) => {
                let text = serde_json::to_string(&value).map_err(serde::de::Error::custom)?;
                Some(ace_json::Raw::from_json(&text).map_err(serde::de::Error::custom)?)
            }
        },
    )
}

/// Serialize an optional verbatim payload.
pub fn serialize_opt_raw<S>(value: &Option<ace_json::Raw>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    match value {
        None => serializer.serialize_none(),
        Some(raw) => serialize_raw(raw, serializer),
    }
}

/// A JSON number the TypeScript reads as an integer (`z.number().int()`:
// any finite value with no fractional part counts). Missing and `null`
// never count.
pub fn as_integer(value: Option<&Json>) -> Option<i64> {
    value?.as_i64()
}

/// A non-negative safe integer, the shape of every timestamp and count.
pub fn as_count(value: Option<&Json>) -> Option<i64> {
    as_integer(value).filter(|int| *int >= 0)
}

/// Parse untrusted JSON (a fact, a draft, a restored state) iteratively:
/// no recursion, no stack growth, depth bounded by memory alone.
pub fn parse_untrusted(text: &str) -> Result<Json, crate::error::CoreError> {
    ace_json::parse(text).map_err(crate::error::CoreError::invalid_json)
}

/// Keep an opaque payload as canonical text, spliced verbatim downstream.
pub fn raw_from(text: &str) -> Result<ace_json::Raw, crate::error::CoreError> {
    ace_json::Raw::from_json(text).map_err(crate::error::CoreError::invalid_json)
}

/// Serialize into the caller's reused buffer: one output buffer per call.
/// Uses ace-json so `Raw` splices verbatim and numbers print as JavaScript.
pub fn write_json(
    buffer: &mut Vec<u8>,
    value: &impl serde::Serialize,
) -> Result<(), crate::error::CoreError> {
    let text =
        ace_json::ser::to_string(value).map_err(crate::error::CoreError::invalid_json_string)?;
    buffer.extend_from_slice(text.as_bytes());
    Ok(())
}

/// Render a value the way `JSON.stringify` field comparison does in
/// `changeAgent`: canonical for values this crate builds itself.
pub fn canonical(value: &Json) -> String {
    ace_json::to_string(value)
}

/// A typed value as a transient `Json` for order-insensitive comparison:
/// serialize via ace-json (JS-exact), parse back, `Null` when unrepresentable.
pub fn to_value<T>(value: &T) -> Json
where
    T: serde::Serialize + ?Sized,
{
    ace_json::ser::to_string(value)
        .ok()
        .and_then(|text| ace_json::parse(&text).ok())
        .unwrap_or(Json::Null)
}

/// Field-by-field equality that ignores object key order, like the
/// TypeScript `equal` in `status.ts`. Iterative: the explicit stack stands
/// in for recursion, so untrusted nesting can never overflow the stack.
/// `null` counts as absent, as the TypeScript does.
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
                        Some(right_value) if *right_value != Json::Null => {
                            stack.push((left_value, right_value));
                        }
                        _ => return false,
                    }
                }
                let right_len = right_map
                    .iter()
                    .filter(|(_, value)| **value != Json::Null)
                    .count();
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
        CollectObject(Vec<ace_json::JsString>),
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
                        let keys: Vec<ace_json::JsString> = map.keys().cloned().collect();
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
                values.push(Json::from(out));
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
                for (key, item) in keys.into_iter().zip(taken) {
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
        "unsupported",
        Json::from(reason.to_owned()),
    )]))
}
