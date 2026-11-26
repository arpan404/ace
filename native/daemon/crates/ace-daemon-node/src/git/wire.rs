// SPDX-License-Identifier: Apache-2.0
//! Reading and writing the binding's JSON frames with `ace-json`, so a value
//! crosses exactly as `JSON.parse`/`JSON.stringify` see it (ADR 0224 §3):
//! lone surrogates survive, keys keep their order, numbers print as JavaScript
//! prints them. Nothing here validates a schema: the core does.

use ace_json::{JsString, Map, Number, Value};

/// A frame's object, or `None` when the text is not a JSON object.
pub fn object(text: &str) -> Option<Map> {
    match ace_json::parse(text) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// One field of a frame's object.
pub fn field<'a>(map: &'a Map, key: &str) -> Option<&'a Value> {
    map.get(key)
}

pub fn string(map: &Map, key: &str) -> Option<String> {
    match field(map, key)? {
        Value::String(text) => Some(text.to_string_lossy().into_owned()),
        _ => None,
    }
}

pub fn number(map: &Map, key: &str) -> Option<f64> {
    match field(map, key)? {
        Value::Number(number) => number.as_f64(),
        _ => None,
    }
}

pub fn boolean(map: &Map, key: &str) -> Option<bool> {
    match field(map, key)? {
        Value::Bool(value) => Some(*value),
        _ => None,
    }
}

pub fn strings(map: &Map, key: &str) -> Option<Vec<String>> {
    match field(map, key)? {
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::String(text) => Some(text.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect(),
        _ => None,
    }
}

/// `[[key, value], ...]` pairs, as an environment arrives from JavaScript.
pub fn pairs(map: &Map, key: &str) -> Option<Vec<(String, String)>> {
    match field(map, key)? {
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Array(pair) => match (pair.first(), pair.get(1)) {
                    (Some(Value::String(k)), Some(Value::String(v))) => Some((
                        k.to_string_lossy().into_owned(),
                        v.to_string_lossy().into_owned(),
                    )),
                    _ => None,
                },
                _ => None,
            })
            .collect(),
        _ => None,
    }
}

/// Flags and numbers that JavaScript sends as booleans/numbers, with a default.
pub fn flag(map: &Map, key: &str) -> bool {
    boolean(map, key).unwrap_or(false)
}

pub fn count(map: &Map, key: &str) -> Option<u64> {
    let value = number(map, key)?;
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 {
        Some(value as u64)
    } else {
        None
    }
}

/// Builds one frame object in insertion order.
#[derive(Default)]
pub struct Frame(Map);

impl Frame {
    pub fn new() -> Self {
        Self(Map::new())
    }

    pub fn set(mut self, key: &'static str, value: Value) -> Self {
        self.0.insert(JsString::from(key), value);
        self
    }

    pub fn text(self, key: &'static str, value: &str) -> Self {
        self.set(key, Value::from(value))
    }

    pub fn number(self, key: &'static str, value: u64) -> Self {
        self.set(key, Value::Number(Number::from(value as f64)))
    }

    pub fn integer(self, key: &'static str, value: i64) -> Self {
        self.set(key, Value::Number(Number::from(value as f64)))
    }

    pub fn boolean(self, key: &'static str, value: bool) -> Self {
        self.set(key, Value::Bool(value))
    }

    pub fn maybe(self, key: &'static str, value: Option<&str>) -> Self {
        match value {
            Some(text) => self.text(key, text),
            None => self.set(key, Value::Null),
        }
    }

    pub fn build(self) -> Value {
        Value::Object(self.0)
    }

    pub fn json(self) -> String {
        ace_json::to_string(&self.build())
    }
}

/// A string array as a value.
pub fn string_array(items: &[String]) -> Value {
    Value::Array(
        items
            .iter()
            .map(|item| Value::from(item.as_str()))
            .collect(),
    )
}
