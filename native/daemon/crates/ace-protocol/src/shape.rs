// SPDX-License-Identifier: Apache-2.0
//! What a Zod parse keeps of a value, hand-written and dependency-free. `shapes` is generated
//! from the schemas by `scripts/rust-protocol-shapes.ts` (porting guide 5.3b): the wire and the
//! projection use it to reproduce Zod's stripping, defaults and key order.
//!
//! Recursion in the walk follows this table, never the input: a [`Shape::Copy`] subtree is
//! cloned by `ace-json` in one non-recursive pass, so the walk's depth is the table's however
//! deeply a value nests.

use ace_json::{Map, Value};

/// What Zod's parse keeps of a value, generated from the schema.
pub enum Shape {
    /// Kept as it is: strings, numbers, booleans, null, enums, literals, `z.unknown`, and
    /// unions, arrays and nullables whose every part is `Copy`.
    Copy,
    /// `z.object`: the fields in schema order; any other key follows them or is dropped, as
    /// [`Extra`] says.
    Object {
        fields: &'static [Field],
        extra: Extra,
    },
    /// `z.array`: each element through the shape.
    Array(&'static Shape),
    /// `z.record` with string keys: own keys in JavaScript order, `__proto__` dropped, each
    /// value through the shape.
    Record(&'static Shape),
    /// `.nullable()`: null is kept, anything else goes through the shape.
    Nullable(&'static Shape),
    /// `z.discriminatedUnion`: the option whose literal, as JSON text (`"\"pr\""`), equals the
    /// value's `key` field printed.
    Tagged {
        key: &'static str,
        options: &'static [(&'static str, Shape)],
    },
    /// `z.union` without a discriminator: the first option the value fits, as Zod tries them.
    OneOf(&'static [Shape]),
    /// A string check that trims (`z.string().trim()`): JavaScript's `trim`, not Rust's.
    Trim,
    /// A recursive schema (`z.lazy`): the table's own reference, followed at run time.
    Later(&'static Shape),
}

/// What a [`Shape::Object`] does with a key its fields do not name.
pub enum Extra {
    /// `z.object`: the key is dropped.
    Strip,
    /// `z.strictObject`: the key is rejected.
    Reject,
    /// `z.looseObject`: the key stays, at its place among the fields.
    Keep,
    /// `z.object(...).and(z.record(...))`: the key stays, shaped by the record's value.
    Shaped(&'static Shape),
}

/// One key of a [`Shape::Object`]: its schema order, whether an absent key stays absent and,
/// for a default, the JSON text inserted at the key's place.
pub struct Field {
    pub key: &'static str,
    pub presence: Presence,
    pub shape: Shape,
}

/// What an absent object key becomes.
pub enum Presence {
    Required,
    /// `.optional()`: an absent key stays absent.
    Optional,
    /// `.default(v)`, `v` as JSON text: an absent key gets `v` at its place.
    Default(&'static str),
}

/// What Zod's parse would return for `shape` and `value`, with a wrong JSON type copied as it
/// is. The input is never changed.
pub fn strip(shape: &Shape, value: &Value) -> Value {
    match shape {
        Shape::Copy => value.clone(),
        Shape::Object { fields, extra } => match value {
            Value::Object(map) => Value::Object(strip_object_with(extra, fields, map)),
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
        Shape::Later(inner) => strip(inner, value),
        Shape::Trim => match value {
            Value::String(text) => Value::String(ace_json::JsString::from(js_trim(text.as_str()))),
            _ => value.clone(),
        },
        Shape::OneOf(options) => {
            for option in *options {
                if fits(option, value) {
                    return strip(option, value);
                }
            }
            value.clone()
        }
    }
}

/// The object one [`Shape::Object`] leaves of `map`: its fields in schema order, defaults at
/// their place, every other key dropped. The caller has checked that `map` is an object.
pub fn strip_object(fields: &[Field], map: &Map) -> Map {
    strip_object_with(&Extra::Strip, fields, map)
}

/// The object one [`Shape::Object`] leaves of `map`, for its [`Extra`] policy.
pub fn strip_object_with(extra: &Extra, fields: &[Field], map: &Map) -> Map {
    if matches!(extra, Extra::Keep | Extra::Shaped(_)) {
        // A loose object starts from the input, so every unnamed key keeps its place and the
        // named ones are re-assigned where they already are; a default an absent key gets
        // follows the input's own keys.
        let mut out = Map::with_capacity(map.len());
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
        if let Extra::Shaped(rest) = extra {
            for (key, value) in map {
                if fields.iter().any(|field| field.key == key.as_str()) {
                    continue;
                }
                out.insert(key, strip(rest, value));
            }
        }
        return out;
    }
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

/// Whether `value` could be what `shape` describes, structurally: the JSON kind each object,
/// array, record, nullable and tag requires, and every required field present. Refinements,
/// bounds and patterns are not checked; [`fits`] chooses a plain union's option, as Zod tries
/// them, and nothing else.
pub fn fits(shape: &Shape, value: &Value) -> bool {
    match shape {
        Shape::Copy => true,
        Shape::Object { fields, extra } => match value {
            Value::Object(map) => {
                if matches!(extra, Extra::Reject)
                    && map
                        .iter()
                        .any(|(key, _)| !fields.iter().any(|f| f.key == key.as_str()))
                {
                    return false;
                }
                if let Extra::Shaped(rest) = extra
                    && !map.iter().all(|(key, item)| {
                        fields.iter().any(|f| f.key == key.as_str()) || fits(rest, item)
                    })
                {
                    return false;
                }
                fields.iter().all(|field| match field.presence {
                    Presence::Required => map
                        .get(field.key)
                        .is_some_and(|item| fits(&field.shape, item)),
                    Presence::Optional | Presence::Default(_) => map
                        .get(field.key)
                        .is_none_or(|item| fits(&field.shape, item)),
                })
            }
            _ => false,
        },
        Shape::Array(inner) => match value {
            Value::Array(items) => items.iter().all(|item| fits(inner, item)),
            _ => false,
        },
        Shape::Record(inner) => match value {
            Value::Object(map) => map.iter().all(|(_, item)| fits(inner, item)),
            _ => false,
        },
        Shape::Nullable(inner) => match value {
            Value::Null => true,
            _ => fits(inner, value),
        },
        Shape::Tagged { key, options } => {
            let Value::Object(map) = value else {
                return false;
            };
            let Some(tag) = map.get(*key) else {
                return false;
            };
            let printed = ace_json::to_string(tag);
            options
                .iter()
                .any(|(literal, option)| printed == *literal && fits(option, value))
        }
        Shape::OneOf(options) => options.iter().any(|option| fits(option, value)),
        Shape::Later(inner) => fits(inner, value),
        Shape::Trim => matches!(value, Value::String(_)),
    }
}

/// `String.prototype.trim`: ECMAScript's whitespace and line terminators, which include NEL's
/// neighbours Rust's `trim` also strips plus `\u{feff}`, and exclude `\u{0085}` which it does.
pub fn js_trim(text: &str) -> &str {
    let whitespace = |c: char| {
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
    };
    text.trim_matches(whitespace)
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
