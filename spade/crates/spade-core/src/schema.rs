//! The bounded schema subset a contract's input and output are written in (ADR 0200 §5.1, §7):
//! objects with known fields, strings with a length, numbers, booleans, enums and arrays with a
//! size, at most six levels deep. Small enough that every value checked against one is bounded,
//! and that the marketplace's reader (`packages/marketplace/src/schema.ts`) reads it the same way
//! (the conformance suite's `contracts/schemas.json` holds both to it). Pure.
//!
//! A schema is JSON Schema's words for these shapes and nothing else: a keyword outside the subset
//! refuses the schema, so a schema can never mean more than this reader checks.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::rule::{self, Problem};

/// The deepest a schema nests: the top value is level one.
pub const MOST_DEPTH: usize = 6;
/// The most fields an object names, values an enum lists, and the longest string or list.
pub const MOST_FIELDS: usize = 64;
pub const MOST_ENUM: usize = 64;
pub const LONGEST_STRING: u64 = 65_536;
pub const MOST_ITEMS: u64 = 1_000;
/// A description's and an enum value's longest text, in characters.
pub const DESCRIPTION_CHARS: usize = 500;
pub const ENUM_CHARS: usize = 200;
/// A whole schema, as JSON.
pub const MOST_SCHEMA_BYTES: usize = 16 * 1024;

/// One schema, read.
#[derive(Debug, Clone, PartialEq)]
pub enum Schema {
    Object {
        fields: BTreeMap<String, Schema>,
        required: Vec<String>,
    },
    String {
        min: u64,
        max: u64,
        /// The only values it takes, when it is an enum.
        one_of: Option<Vec<String>>,
    },
    Number {
        integer: bool,
        min: Option<f64>,
        max: Option<f64>,
    },
    Boolean,
    Array {
        items: Box<Schema>,
        min: u64,
        max: u64,
    },
}

/// Where a value doesn't fit, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Misfit {
    /// `input.from`, `output.fares[2]`.
    pub at: String,
    pub why: String,
}

impl std::fmt::Display for Misfit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.at, self.why)
    }
}

/// Reads `value` as a schema of the subset; every problem, each at its place (`at` names the
/// schema, `contracts[0].input`).
pub fn read(value: &Value, at: &str) -> Result<Schema, Vec<Problem>> {
    let mut problems = Vec::new();
    if value.to_string().len() > MOST_SCHEMA_BYTES {
        return Err(vec![Problem::new(
            rule::SCHEMA_SIZE,
            format!("{at} is longer than {} KiB", MOST_SCHEMA_BYTES / 1024),
        )]);
    }
    let schema = node(value, at, 1, &mut problems);
    match schema {
        Some(schema) if problems.is_empty() => Ok(schema),
        _ => Err(problems),
    }
}

pub(crate) const COMMON: [&str; 3] = ["type", "description", "title"];
/// Each kind of the subset, with the keywords it takes beside the common ones, in the order the
/// spec lists them.
pub(crate) const KINDS: [(&str, &[&str]); 5] = [
    ("object", &OBJECT_KEYWORDS),
    ("string", &STRING_KEYWORDS),
    ("number, integer", &NUMBER_KEYWORDS),
    ("boolean", &[]),
    ("array", &ARRAY_KEYWORDS),
];
const OBJECT_KEYWORDS: [&str; 3] = ["properties", "required", "additionalProperties"];
const STRING_KEYWORDS: [&str; 3] = ["maxLength", "minLength", "enum"];
const NUMBER_KEYWORDS: [&str; 2] = ["minimum", "maximum"];
const ARRAY_KEYWORDS: [&str; 3] = ["items", "maxItems", "minItems"];
/// Every keyword some kind of the subset takes.
const EVERY_KEYWORD: [&str; 11] = [
    "properties",
    "required",
    "additionalProperties",
    "maxLength",
    "minLength",
    "enum",
    "minimum",
    "maximum",
    "items",
    "maxItems",
    "minItems",
];

fn keywords(fields: &Map<String, Value>, at: &str, allowed: &[&str], out: &mut Vec<Problem>) {
    for key in fields.keys() {
        if !COMMON.contains(&key.as_str()) && !allowed.contains(&key.as_str()) {
            out.push(Problem::new(
                rule::SCHEMA_KEYWORD,
                format!("{at}: {key:?} isn't in the schema subset contracts use"),
            ));
        }
    }
    for key in ["description", "title"] {
        match fields.get(key) {
            None => {}
            Some(Value::String(text)) if text.chars().count() <= DESCRIPTION_CHARS => {}
            Some(_) => out.push(Problem::new(
                rule::SCHEMA_TEXT,
                format!("{at}.{key} is text of at most {DESCRIPTION_CHARS} characters"),
            )),
        }
    }
}

fn count(fields: &Map<String, Value>, key: &str, at: &str, out: &mut Vec<Problem>) -> Option<u64> {
    let value = fields.get(key)?;
    match value.as_u64() {
        Some(n) => Some(n),
        None => {
            out.push(Problem::new(
                rule::SCHEMA_BOUND,
                format!("{at}.{key} is a whole number"),
            ));
            None
        }
    }
}

fn node(value: &Value, at: &str, depth: usize, out: &mut Vec<Problem>) -> Option<Schema> {
    if depth > MOST_DEPTH {
        out.push(Problem::new(
            rule::SCHEMA_DEPTH,
            format!("{at}: a schema nests at most {MOST_DEPTH} levels"),
        ));
        return None;
    }
    let Some(fields) = value.as_object() else {
        out.push(Problem::new(
            rule::SCHEMA_OBJECT,
            format!("{at} is a schema object"),
        ));
        return None;
    };
    let kind = match fields.get("type") {
        Some(Value::String(kind)) => kind.as_str(),
        // An enum alone is a string enum.
        None if fields.contains_key("enum") => "string",
        _ => {
            // A keyword of another kind of schema (`$ref`, `oneOf`) says so first.
            keywords(fields, at, &EVERY_KEYWORD, out);
            out.push(Problem::new(
                rule::SCHEMA_TYPE,
                format!("{at}.type is object, string, number, integer, boolean or array"),
            ));
            return None;
        }
    };
    match kind {
        "object" => object(fields, at, depth, out),
        "string" => string(fields, at, out),
        "number" | "integer" => {
            keywords(fields, at, &NUMBER_KEYWORDS, out);
            let bound = |key: &str, out: &mut Vec<Problem>| match fields.get(key) {
                None => None,
                Some(n) if n.is_number() => n.as_f64(),
                Some(_) => {
                    out.push(Problem::new(
                        rule::SCHEMA_BOUND,
                        format!("{at}.{key} is a number"),
                    ));
                    None
                }
            };
            let (min, max) = (bound("minimum", out), bound("maximum", out));
            if let (Some(min), Some(max)) = (min, max)
                && min > max
            {
                out.push(Problem::new(
                    rule::SCHEMA_BOUND,
                    format!("{at}: minimum is more than maximum"),
                ));
            }
            Some(Schema::Number {
                integer: kind == "integer",
                min,
                max,
            })
        }
        "boolean" => {
            keywords(fields, at, &[], out);
            Some(Schema::Boolean)
        }
        "array" => {
            keywords(fields, at, &ARRAY_KEYWORDS, out);
            let max = count(fields, "maxItems", at, out);
            let min = count(fields, "minItems", at, out).unwrap_or(0);
            let max = match max {
                Some(max) if (1..=MOST_ITEMS).contains(&max) => max,
                _ => {
                    out.push(Problem::new(
                        rule::SCHEMA_MAX_ITEMS,
                        format!("{at}.maxItems says how long the list may be, 1 to {MOST_ITEMS}"),
                    ));
                    1
                }
            };
            if min > max {
                out.push(Problem::new(
                    rule::SCHEMA_BOUND,
                    format!("{at}: minItems is more than maxItems"),
                ));
            }
            let items = match fields.get("items") {
                Some(items) => node(items, &format!("{at}.items"), depth + 1, out)?,
                None => {
                    out.push(Problem::new(
                        rule::SCHEMA_MAX_ITEMS,
                        format!("{at}.items says what the list holds"),
                    ));
                    return None;
                }
            };
            Some(Schema::Array {
                items: Box::new(items),
                min,
                max,
            })
        }
        other => {
            out.push(Problem::new(
                rule::SCHEMA_TYPE,
                format!(
                    "{at}.type {other:?} isn't object, string, number, integer, boolean or array"
                ),
            ));
            None
        }
    }
}

fn object(
    fields: &Map<String, Value>,
    at: &str,
    depth: usize,
    out: &mut Vec<Problem>,
) -> Option<Schema> {
    keywords(fields, at, &OBJECT_KEYWORDS, out);
    match fields.get("additionalProperties") {
        None | Some(Value::Bool(false)) => {}
        Some(_) => out.push(Problem::new(
            rule::SCHEMA_CLOSED,
            format!("{at}.additionalProperties is false: an object has only the fields it names"),
        )),
    }
    let properties = match fields.get("properties") {
        None => Map::new(),
        Some(Value::Object(properties)) if properties.len() <= MOST_FIELDS => properties.clone(),
        Some(_) => {
            out.push(Problem::new(
                rule::SCHEMA_FIELDS,
                format!("{at}.properties names at most {MOST_FIELDS} fields"),
            ));
            return None;
        }
    };
    let mut read = BTreeMap::new();
    for (name, value) in &properties {
        if !field_name(name) {
            out.push(Problem::new(
                rule::SCHEMA_FIELDS,
                format!(
                    "{at}.properties: {name:?} is a field name of 1 to 64 letters, digits and _"
                ),
            ));
            continue;
        }
        if let Some(schema) = node(value, &format!("{at}.{name}"), depth + 1, out) {
            read.insert(name.clone(), schema);
        }
    }
    let required: Vec<String> = match fields.get("required") {
        None => Vec::new(),
        Some(Value::Array(names)) => names
            .iter()
            .filter_map(|name| match name.as_str() {
                Some(name) if properties.contains_key(name) => Some(name.to_owned()),
                _ => {
                    out.push(Problem::new(
                        rule::SCHEMA_REQUIRED,
                        format!("{at}.required names fields its properties have"),
                    ));
                    None
                }
            })
            .collect(),
        Some(_) => {
            out.push(Problem::new(
                rule::SCHEMA_REQUIRED,
                format!("{at}.required is a list of field names"),
            ));
            Vec::new()
        }
    };
    Some(Schema::Object {
        fields: read,
        required,
    })
}

fn string(fields: &Map<String, Value>, at: &str, out: &mut Vec<Problem>) -> Option<Schema> {
    keywords(fields, at, &STRING_KEYWORDS, out);
    let one_of = match fields.get("enum") {
        None => None,
        Some(Value::Array(values)) if (1..=MOST_ENUM).contains(&values.len()) => {
            let words: Option<Vec<String>> = values
                .iter()
                .map(|v| {
                    v.as_str()
                        .filter(|w| w.chars().count() <= ENUM_CHARS)
                        .map(str::to_owned)
                })
                .collect();
            if words.is_none() {
                out.push(Problem::new(
                    rule::SCHEMA_ENUM,
                    format!("{at}.enum lists words of at most {ENUM_CHARS} characters"),
                ));
            }
            words
        }
        Some(_) => {
            out.push(Problem::new(
                rule::SCHEMA_ENUM,
                format!("{at}.enum lists 1 to {MOST_ENUM} words"),
            ));
            None
        }
    };
    let longest = one_of
        .as_ref()
        .and_then(|words| words.iter().map(|w| w.chars().count() as u64).max());
    let max = match (count(fields, "maxLength", at, out), longest) {
        (Some(max), _) if (1..=LONGEST_STRING).contains(&max) => max,
        // An enum's length is its longest word's.
        (None, Some(longest)) => longest.max(1),
        _ => {
            out.push(Problem::new(
                rule::SCHEMA_MAX_LENGTH,
                format!("{at}.maxLength says how long the text may be, 1 to {LONGEST_STRING}"),
            ));
            1
        }
    };
    let min = count(fields, "minLength", at, out).unwrap_or(0);
    if min > max {
        out.push(Problem::new(
            rule::SCHEMA_BOUND,
            format!("{at}: minLength is more than maxLength"),
        ));
    }
    Some(Schema::String { min, max, one_of })
}

fn field_name(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// What a check makes of a field an object's schema doesn't name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unnamed {
    /// A misfit: the side that writes a value writes only what its schema names.
    Refused,
    /// Passed over: the side that reads a value may meet fields a newer schema added.
    Passed,
}

impl Schema {
    /// Every place `value` doesn't fit, under `at` (`input`); empty when it fits. A field the
    /// schema doesn't name is a misfit: this is the check on the side that writes the value.
    pub fn check(&self, value: &Value, at: &str) -> Vec<Misfit> {
        let mut out = Vec::new();
        self.walk(value, at, Unnamed::Refused, &mut out);
        out
    }

    /// As [`Schema::check`], for the side that reads the value: a field the schema doesn't name
    /// passes, since a newer version of the schema may add optional fields (the market signs
    /// such a change as compatible), and every named field is still checked.
    pub fn check_reading(&self, value: &Value, at: &str) -> Vec<Misfit> {
        let mut out = Vec::new();
        self.walk(value, at, Unnamed::Passed, &mut out);
        out
    }

    fn walk(&self, value: &Value, at: &str, unnamed: Unnamed, out: &mut Vec<Misfit>) {
        // Enough to say what to fix; a value that misses everywhere doesn't list it all.
        if out.len() >= 20 {
            return;
        }
        let miss = |out: &mut Vec<Misfit>, why: String| {
            out.push(Misfit {
                at: at.to_owned(),
                why,
            });
        };
        match (self, value) {
            (Self::Object { fields, required }, Value::Object(given)) => {
                for name in required {
                    if !given.contains_key(name) {
                        out.push(Misfit {
                            at: format!("{at}.{name}"),
                            why: "is missing".to_owned(),
                        });
                    }
                }
                for (name, item) in given {
                    match fields.get(name) {
                        Some(schema) => schema.walk(item, &format!("{at}.{name}"), unnamed, out),
                        None if unnamed == Unnamed::Passed => {}
                        None => out.push(Misfit {
                            at: format!("{at}.{name}"),
                            why: "isn't a field this takes".to_owned(),
                        }),
                    }
                }
            }
            (Self::String { min, max, one_of }, Value::String(text)) => {
                let length = text.chars().count() as u64;
                if let Some(words) = one_of {
                    if !words.iter().any(|w| w == text) {
                        miss(out, format!("is one of {}", words.join(", ")));
                    }
                } else if length > *max {
                    miss(out, format!("is at most {max} characters"));
                } else if length < *min {
                    miss(out, format!("is at least {min} characters"));
                }
            }
            (Self::Number { integer, min, max }, Value::Number(n)) => {
                let x = n.as_f64().unwrap_or(f64::NAN);
                // `3.0` is whole, as JavaScript reads it: both readers agree on every number.
                if *integer && x.fract() != 0.0 {
                    miss(out, "is a whole number".to_owned());
                } else if min.is_some_and(|min| x < min) {
                    miss(out, format!("is at least {}", min.unwrap_or_default()));
                } else if max.is_some_and(|max| x > max) {
                    miss(out, format!("is at most {}", max.unwrap_or_default()));
                }
            }
            (Self::Boolean, Value::Bool(_)) => {}
            (Self::Array { items, min, max }, Value::Array(given)) => {
                let length = given.len() as u64;
                if length > *max {
                    miss(out, format!("holds at most {max} items"));
                } else if length < *min {
                    miss(out, format!("holds at least {min} items"));
                }
                for (i, item) in given.iter().enumerate().take(*max as usize) {
                    items.walk(item, &format!("{at}[{i}]"), unnamed, out);
                }
            }
            (schema, _) => miss(out, format!("is {}", schema.kind())),
        }
    }

    /// The kind in words: "an object", "text".
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Object { .. } => "an object",
            Self::String {
                one_of: Some(_), ..
            } => "one of its words",
            Self::String { .. } => "text",
            Self::Number { integer: true, .. } => "a whole number",
            Self::Number { .. } => "a number",
            Self::Boolean => "true or false",
            Self::Array { .. } => "a list",
        }
    }
}

/// Every misfit as one line each, for a refusal or a tool's answer.
pub fn lines(misfits: &[Misfit]) -> String {
    misfits
        .iter()
        .map(|m| format!("- {m}"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests;
