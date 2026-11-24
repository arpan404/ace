// SPDX-License-Identifier: Apache-2.0
//! Zod's parse of a value, minus validation: the shape table says what each object keeps, in
//! which order, and which defaults an absent key gets (porting guide 5.3b). Recursion follows
//! the table, never the value: a [`Shape::Copy`] subtree is cloned by `ace-json` in one
//! non-recursive pass, so the depth is the table's whatever the input.

use ace_json::{Map, Value};
use ace_protocol::shape::{Field, Presence, Shape};

/// What Zod's parse would return for `shape` and `value`, with a wrong JSON type copied as it
/// is. The input is never changed.
pub fn strip(shape: &Shape, value: &Value) -> Value {
    match shape {
        Shape::Copy => value.clone(),
        Shape::Object(fields) => match value {
            Value::Object(map) => Value::Object(strip_object(fields, map)),
            _ => value.clone(),
        },
        Shape::Array(inner) => match value {
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| strip(inner, item)).collect())
            }
            _ => value.clone(),
        },
        Shape::Record(inner) => strip_record(inner, value),
        Shape::Nullable(inner) => match value {
            Value::Null => value.clone(),
            _ => strip(inner, value),
        },
        Shape::Tagged { key, options } => strip_tagged(key, options, value),
    }
}

/// The object one [`Shape::Object`] leaves of `map`: its fields in schema order, defaults at
/// their place, every other key dropped. The caller has checked that `map` is an object.
pub fn strip_object(fields: &[Field], map: &Map) -> Map {
    let mut out = Map::with_capacity(fields.len());
    for field in fields {
        match map.get(field.key) {
            Some(value) => {
                out.insert(field.key, strip(&field.shape, value));
            }
            None => {
                if let Presence::Default(text) = field.presence {
                    out.insert(field.key, ace_json::parse(text).unwrap_or(Value::Null));
                }
            }
        }
    }
    out
}

fn strip_record(inner: &Shape, value: &Value) -> Value {
    let Value::Object(map) = value else {
        return value.clone();
    };
    let mut out = Map::with_capacity(map.len());
    for (key, item) in map {
        if key.as_str() == "__proto__" {
            continue;
        }
        out.insert(key, strip(inner, item));
    }
    Value::Object(out)
}

fn strip_tagged(key: &str, options: &[(&str, Shape)], value: &Value) -> Value {
    let Value::Object(map) = value else {
        return value.clone();
    };
    let Some(tag) = map.get(key) else {
        return value.clone();
    };
    let printed = ace_json::to_string(tag);
    for (literal, shape) in options {
        if printed == *literal {
            return strip(shape, value);
        }
    }
    value.clone()
}
