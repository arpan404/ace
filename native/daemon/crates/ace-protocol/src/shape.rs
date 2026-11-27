// SPDX-License-Identifier: Apache-2.0
//! What a Zod parse keeps of a value, hand-written and dependency-free. `shapes` is generated
//! from the schemas by `scripts/rust-protocol-shapes.ts` (porting guide 5.3b): the wire and the
//! projection use it to reproduce Zod's stripping, defaults, bounds and key order.
//!
//! Recursion in the walk follows this table, never the input: a [`Shape::Any`] subtree is
//! cloned by `ace-json` in one non-recursive pass, so the walk's depth is the table's however
//! deeply a value nests.

use ace_json::{Map, Value};

/// What Zod's parse keeps of a value, generated from the schema.
pub enum Shape {
    /// `z.unknown()`/`z.any()`: any JSON value, kept as it is.
    Any,
    Null,
    Bool,
    /// `z.string()` with its checks in the order Zod runs them (`.trim()` included).
    Str(&'static StrBounds),
    /// `z.number()` with its bounds and integrality.
    Num(&'static NumBounds),
    /// `z.literal`/`z.enum`: the allowed values as JSON text (`"\"pr\""`, `"true"`).
    Enum(&'static [&'static str]),
    /// `z.object`: the fields in schema order; any other key follows them, is dropped or is
    /// rejected, as [`Extra`] says.
    Object {
        fields: &'static [Field],
        extra: Extra,
    },
    /// `z.array`: each element through the shape, with the length Zod allows.
    Array {
        item: &'static Shape,
        min: Option<u32>,
        max: Option<u32>,
    },
    /// `z.tuple`: one shape per slot.
    Tuple(&'static [Shape]),
    /// `z.record` with string keys: own keys in JavaScript order, `__proto__` dropped (or kept
    /// for an opaque-id map that rebuilds its entries), each key and value through its shape.
    Record {
        key: &'static Shape,
        value: &'static Shape,
        keep_proto: bool,
    },
    /// `.nullable()`: null is kept, anything else goes through the shape.
    Nullable(&'static Shape),
    /// `z.discriminatedUnion`: the option whose literal, as JSON text, equals the value's
    /// `key` field printed.
    Tagged {
        key: &'static str,
        options: &'static [(&'static str, Shape)],
    },
    /// `z.union` without a discriminator: the first option the value fits, as Zod tries them.
    OneOf(&'static [Shape]),
    /// An intersection whose sides are not objects: the value must fit every side.
    All(&'static [Shape]),
    /// A recursive schema (`z.lazy`): the table's own reference, followed at run time.
    Later(&'static Shape),
    /// A `.transform()` whose output JSON Schema cannot state: a hand-written pair of
    /// functions, the only shape that runs code.
    Custom(&'static Custom),
    /// An object key Zod turns into `undefined` when its own shape doesn't fit (the hello's
    /// `lastClose`): accepted as anything, dropped from the output.
    Option(&'static Shape),
    /// `.catch(fallback)`: anything is accepted; a value that doesn't fit becomes `fallback`.
    Catch {
        inner: &'static Shape,
        fallback: &'static str,
    },
    /// A `.refine()`/`.superRefine()`: the value must fit the shape and the hand-written rule,
    /// which sees the value Zod's own earlier checks would have produced.
    Checked {
        inner: &'static Shape,
        check: &'static Check,
    },
    /// A transform option inside a union: values the rest doesn't fit are read as the
    /// transform's constant output, provided they fit the transform's input.
    Fallback {
        rest: &'static Shape,
        input: &'static Shape,
        fallback: &'static str,
    },
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

/// A string's checks, in the order Zod applies them: lengths in code points (rule 17), a
/// JavaScript pattern, a named format, `.trim()`, and any hand-written refinement.
pub enum StrCheck {
    Min(u32),
    Max(u32),
    Pattern(&'static str),
    Format(&'static str),
    Trim,
    Custom(&'static Check),
}

/// A string's ordered checks.
pub struct StrBounds {
    pub checks: &'static [StrCheck],
}

/// A `.refine()`/`.superRefine()` rule, hand-written in `checks.rs`.
pub struct Check(pub fn(&Value) -> bool);

/// A number's bounds; `inclusive` is what Zod's `.min()`/`.max()` choose.
pub struct NumBounds {
    pub min: Option<f64>,
    pub min_inclusive: bool,
    pub max: Option<f64>,
    pub max_inclusive: bool,
    pub integral: bool,
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
        Shape::Any | Shape::Null | Shape::Bool | Shape::Num(_) | Shape::Enum(_) => value.clone(),
        Shape::Str(bounds) => match value {
            Value::String(text)
                if bounds
                    .checks
                    .iter()
                    .any(|check| matches!(check, StrCheck::Trim)) =>
            {
                Value::String(ace_json::JsString::from(js_trim(text.as_str())))
            }
            _ => value.clone(),
        },
        Shape::Object { fields, extra } => match value {
            Value::Object(map) => Value::Object(strip_object_with(extra, fields, map)),
            _ => value.clone(),
        },
        Shape::Array { item, .. } => match value {
            Value::Array(items) => {
                Value::Array(items.iter().map(|entry| strip(item, entry)).collect())
            }
            _ => value.clone(),
        },
        Shape::Tuple(items) => match value {
            Value::Array(values) => Value::Array(
                values
                    .iter()
                    .enumerate()
                    .map(|(index, entry)| match items.get(index) {
                        Some(shape) => strip(shape, entry),
                        None => entry.clone(),
                    })
                    .collect(),
            ),
            _ => value.clone(),
        },
        Shape::Record {
            value: inner,
            keep_proto,
            ..
        } => strip_record(inner, *keep_proto, value),
        Shape::Nullable(inner) => match value {
            Value::Null => value.clone(),
            _ => strip(inner, value),
        },
        Shape::Tagged { key, options } => strip_tagged(key, options, value),
        Shape::All(shapes) => match shapes.first() {
            Some(first) => strip(first, value),
            None => value.clone(),
        },
        Shape::Later(inner) => strip(inner, value),
        Shape::Custom(custom) => (custom.strip)(value).unwrap_or_else(|| value.clone()),
        Shape::Option(inner) => {
            if fits(inner, value) {
                strip(inner, value)
            } else {
                value.clone()
            }
        }
        Shape::Catch { inner, fallback } => {
            if fits(inner, value) {
                strip(inner, value)
            } else {
                ace_json::parse(fallback).unwrap_or(Value::Null)
            }
        }
        Shape::Checked { inner, .. } => strip(inner, value),
        Shape::Fallback {
            rest,
            input,
            fallback,
        } => {
            if fits(rest, value) {
                strip(rest, value)
            } else if fits(input, value) {
                ace_json::parse(fallback).unwrap_or(Value::Null)
            } else {
                value.clone()
            }
        }
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

/// What a [`Shape::Custom`] does: whether a value is what Zod accepts, and what Zod's parse
/// returns for it (`None` drops an object key).
pub struct Custom {
    pub fits: fn(&Value) -> bool,
    pub strip: fn(&Value) -> Option<Value>,
}

/// The object one [`Shape::Object`] leaves of `map`, dropping unnamed keys.
pub fn strip_object(fields: &[Field], map: &Map) -> Map {
    strip_object_with(&Extra::Strip, fields, map)
}

/// The object one [`Shape::Object`] leaves of `map`, for its [`Extra`] policy.
pub fn strip_object_with(extra: &Extra, fields: &[Field], map: &Map) -> Map {
    match extra {
        Extra::Keep | Extra::Shaped(_) => {
            // A loose object (or one intersected with a record) starts from the input, so
            // every key keeps its place: a named one is replaced by its parsed value, an
            // unnamed one is kept (or shaped by the record's value).
            let mut out = Map::with_capacity(map.len());
            for (key, value) in map {
                match field(fields, key) {
                    Some(field) => {
                        if let Shape::Option(inner) = &field.shape {
                            if fits(inner, value) {
                                out.insert(key, strip(inner, value));
                            }
                            continue;
                        }
                        out.insert(key, strip(&field.shape, value));
                    }
                    None => {
                        let shaped = match extra {
                            Extra::Shaped(inner) => strip(inner, value),
                            _ => value.clone(),
                        };
                        out.insert(key, shaped);
                    }
                }
            }
            for field in fields {
                if map.get(field.key).is_none()
                    && let Presence::Default(text) = field.presence
                {
                    out.insert(field.key, ace_json::parse(text).unwrap_or(Value::Null));
                }
            }
            out
        }
        Extra::Strip | Extra::Reject => {
            let mut out = Map::with_capacity(fields.len());
            for field in fields {
                match map.get(field.key) {
                    Some(value) => {
                        if let Shape::Option(inner) = &field.shape {
                            if fits(inner, value) {
                                out.insert(field.key, strip(inner, value));
                            }
                            continue;
                        }
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
    }
}

fn field<'a>(fields: &'a [Field], key: &str) -> Option<&'a Field> {
    fields.iter().find(|candidate| candidate.key == key)
}

/// Whether `value` could be what `shape` describes: the JSON kind, lengths (code points),
/// patterns, formats, numeric ranges, required fields and tags. This is Zod's validation, so a
/// value it rejects is refused here for the same reason.
pub fn fits(shape: &Shape, value: &Value) -> bool {
    match shape {
        Shape::Any => true,
        Shape::Null => matches!(value, Value::Null),
        Shape::Bool => matches!(value, Value::Bool(_)),
        Shape::Str(bounds) => fits_str(bounds, value),
        Shape::Num(bounds) => fits_num(bounds, value),
        Shape::Enum(values) => {
            let printed = ace_json::to_string(value);
            values.iter().any(|candidate| *candidate == printed)
        }
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
        Shape::Array { item, min, max } => match value {
            Value::Array(items) => {
                let len = items.len() as u32;
                if min.is_some_and(|min| len < min) || max.is_some_and(|max| len > max) {
                    return false;
                }
                items.iter().all(|entry| fits(item, entry))
            }
            _ => false,
        },
        Shape::Tuple(items) => match value {
            Value::Array(values) => {
                values.len() == items.len()
                    && values
                        .iter()
                        .zip(items.iter())
                        .all(|(value, shape)| fits(shape, value))
            }
            _ => false,
        },
        Shape::Record {
            key,
            value: inner,
            keep_proto,
        } => match value {
            Value::Object(map) => map.iter().all(|(key_text, item)| {
                (*keep_proto || key_text.as_str() != "__proto__")
                    && fits(key, &Value::String(key_text.clone()))
                    && fits(inner, item)
            }),
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
        Shape::All(shapes) => shapes.iter().all(|shape| fits(shape, value)),
        Shape::Later(inner) => fits(inner, value),
        Shape::Custom(custom) => (custom.fits)(value),
        Shape::Checked { inner, check } => fits(inner, value) && (check.0)(&strip(inner, value)),
        Shape::Option(_) | Shape::Catch { .. } => true,
        Shape::Fallback { rest, input, .. } => fits(rest, value) || fits(input, value),
    }
}

fn fits_str(bounds: &StrBounds, value: &Value) -> bool {
    let Value::String(text) = value else {
        return false;
    };
    let mut text = text.clone();
    for check in bounds.checks {
        match check {
            StrCheck::Trim => {
                text = ace_json::JsString::from(js_trim(text.as_str()));
            }
            StrCheck::Min(min) => {
                if (text.len_code_points() as u32) < *min {
                    return false;
                }
            }
            StrCheck::Max(max) => {
                if (text.len_code_points() as u32) > *max {
                    return false;
                }
            }
            StrCheck::Pattern(pattern) => {
                if !matches_pattern(pattern, text.as_str()) {
                    return false;
                }
            }
            StrCheck::Format(format) => {
                if !matches_format(format, text.as_str()) {
                    return false;
                }
            }
            StrCheck::Custom(check) => {
                if !(check.0)(&Value::String(text.clone())) {
                    return false;
                }
            }
        }
    }
    true
}

fn matches_format(format: &str, text: &str) -> bool {
    match format {
        "url" => url::Url::parse(text).is_ok(),
        "email" => email(text),
        "uuid" => uuid(text),
        "date" => date(text),
        "datetime" => datetime(text),
        _ => {
            // An unknown format is a generator bug; refusing is the loud failure.
            false
        }
    }
}

fn fits_num(bounds: &NumBounds, value: &Value) -> bool {
    let Value::Number(number) = value else {
        return false;
    };
    let number = number.value();
    if !number.is_finite() {
        return false;
    }
    if bounds.integral && (number.fract() != 0.0 || number.abs() > 9_007_199_254_740_991.0) {
        return false;
    }
    if let Some(min) = bounds.min {
        if bounds.min_inclusive {
            if number < min {
                return false;
            }
        } else if number <= min {
            return false;
        }
    }
    if let Some(max) = bounds.max {
        if bounds.max_inclusive {
            if number > max {
                return false;
            }
        } else if number >= max {
            return false;
        }
    }
    true
}

/// A JavaScript regular expression, with ECMAScript's ASCII `\w` and `\d` (and ASCII `\s`),
/// compiled as Rust's syntax allows. A pattern Rust cannot compile (`(?=`, back references)
/// never matches here; the generator's property check names it rather than letting it pass.
fn matches_pattern(pattern: &str, text: &str) -> bool {
    let pattern = js_pattern(pattern);
    fancy_regex::Regex::new(&pattern).is_ok_and(|regex| regex.is_match(text).unwrap_or(false))
}

/// Rewrite `\w`, `\d` and `\s` (and their negations) to their ECMAScript character classes.
fn js_pattern(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len() + 16);
    let mut chars = pattern.chars().peekable();
    let mut in_class = false;
    while let Some(character) = chars.next() {
        match character {
            '[' => {
                in_class = true;
                out.push(character);
            }
            ']' => {
                in_class = false;
                out.push(character);
            }
            '\\' => {
                let Some(next) = chars.next() else {
                    out.push('\\');
                    break;
                };
                match (next, in_class) {
                    ('w', false) => out.push_str("[A-Za-z0-9_]"),
                    ('W', false) => out.push_str("[^A-Za-z0-9_]"),
                    ('d', false) => out.push_str("[0-9]"),
                    ('D', false) => out.push_str("[^0-9]"),
                    ('s', false) => out.push_str("[ \\t\\n\\r\\x0B\\x0C]"),
                    ('S', false) => out.push_str("[^ \\t\\n\\r\\x0B\\x0C]"),
                    ('w', true) => out.push_str("A-Za-z0-9_"),
                    ('d', true) => out.push_str("0-9"),
                    ('s', true) => out.push_str(" \\t\\n\\r\\x0B\\x0C"),
                    _ => {
                        out.push('\\');
                        out.push(next);
                    }
                }
            }
            _ => out.push(character),
        }
    }
    out
}

/// Zod's `email` format: one `@`, a non-empty local part and a dotted domain, no whitespace.
fn email(text: &str) -> bool {
    let mut parts = text.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !local.is_empty()
        && !local.starts_with('.')
        && !local.ends_with('.')
        && !local.contains("..")
        && !text.chars().any(char::is_whitespace)
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && domain.split('.').all(|label| {
            !label.is_empty() && label.chars().all(|c| c.is_alphanumeric() || c == '-')
        })
}

/// `z.uuid()`: 8-4-4-4-12 hexadecimal, any version.
fn uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && [8, 4, 4, 4, 12]
            .iter()
            .zip(&groups)
            .all(|(len, group)| group.len() == *len && group.chars().all(|c| c.is_ascii_hexdigit()))
}

fn strip_record(inner: &Shape, keep_proto: bool, value: &Value) -> Value {
    let Value::Object(map) = value else {
        return value.clone();
    };
    let mut out = Map::with_capacity(map.len());
    for (key, item) in map {
        if !keep_proto && key.as_str() == "__proto__" {
            continue;
        }
        out.insert(key.clone(), strip(inner, item));
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

/// `z.iso.date()`: `YYYY-MM-DD` naming a calendar day.
fn date(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let (Some(year), Some(month), Some(day)) = (
        text.get(0..4).and_then(|part| part.parse::<i32>().ok()),
        text.get(5..7).and_then(|part| part.parse::<u32>().ok()),
        text.get(8..10).and_then(|part| part.parse::<u32>().ok()),
    ) else {
        return false;
    };
    if !bytes[0..4].iter().all(u8::is_ascii_digit)
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || !bytes[8..10].iter().all(u8::is_ascii_digit)
    {
        return false;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&day)
}

/// `z.iso.datetime()`: a date, `T`, a time with seconds, and `Z` or an offset.
fn datetime(text: &str) -> bool {
    let Some((day, rest)) = text.split_once('T') else {
        return false;
    };
    if !date(day) {
        return false;
    }
    let zone_index = rest.find(['Z', '+', '-']).unwrap_or(rest.len());
    let (time, zone) = rest.split_at(zone_index);
    let mut parts = time.split(':');
    let (Some(hour), Some(minute), Some(second)) = (parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    if parts.next().is_some() {
        return false;
    }
    let second = second.split('.').next().unwrap_or(second);
    let parse = |part: &str, max: u32| part.parse::<u32>().ok().filter(|value| *value <= max);
    let (Some(hour), Some(minute), Some(second)) =
        (parse(hour, 23), parse(minute, 59), parse(second, 59))
    else {
        return false;
    };
    let _ = (hour, minute, second);
    if zone.is_empty() || zone == "Z" {
        return true;
    }
    let offset = zone.strip_prefix(['+', '-']).unwrap_or(zone);
    if offset.len() != 5 || offset.as_bytes()[2] != b':' {
        return false;
    }
    let (Some(hours), Some(minutes)) = (
        offset.get(0..2).and_then(|part| part.parse::<u32>().ok()),
        offset.get(3..5).and_then(|part| part.parse::<u32>().ok()),
    ) else {
        return false;
    };
    hours <= 23 && minutes <= 59
}
