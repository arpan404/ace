//! Data schemas a package declares (ADR 0200 §5): a panel's state and each of its actions' values,
//! written as a bounded subset of JSON Schema. Objects have known fields (nothing else is
//! accepted), strings have a length, arrays a size, and nesting stops at six levels, so data
//! that fits is always small and its shape always known. A declaration is read strictly: a
//! keyword this build doesn't enforce (`pattern`, `format`, `$ref`) refuses it rather than being
//! skipped, so a schema never promises a check that isn't made. The marketplace reads
//! declarations the same way (`packages/marketplace/src/data-schema.ts`, held to the same rules
//! by `package/rules.json`). Pure.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

use crate::card::Problem;

/// Levels of nesting a schema may have: the top is level one.
pub const MOST_DEPTH: usize = 6;
pub const MOST_PROPERTIES: usize = 64;
pub const MOST_WORDS: usize = 64;
pub const WORD_CHARS: usize = 200;
pub const MOST_TEXT: u64 = 10_000;
pub const MOST_ITEMS: u64 = 1_000;
const ABOUT_CHARS: usize = 500;
const TITLE_CHARS: usize = 120;
/// Problems listed before the rest are summed up, so a refusal stays readable.
const MOST_PROBLEMS: usize = 20;

/// A declaration, read.
#[derive(Debug, Clone, PartialEq)]
pub enum Schema {
    Object {
        properties: BTreeMap<String, Schema>,
        required: BTreeSet<String>,
    },
    Array {
        items: Box<Schema>,
        min_items: u64,
        max_items: u64,
    },
    String {
        min_length: u64,
        max_length: u64,
    },
    /// One of these words.
    Enum(Vec<String>),
    Number {
        integer: bool,
        minimum: Option<f64>,
        maximum: Option<f64>,
    },
    Boolean,
}

/// Every keyword a node may carry, by its type. `description` and `title` are words for people.
fn keywords(kind: &str) -> &'static [&'static str] {
    match kind {
        "object" => &["type", "properties", "required", "description", "title"],
        "array" => &[
            "type",
            "items",
            "minItems",
            "maxItems",
            "description",
            "title",
        ],
        "string" => &[
            "type",
            "minLength",
            "maxLength",
            "enum",
            "description",
            "title",
        ],
        "number" | "integer" => &["type", "minimum", "maximum", "description", "title"],
        "boolean" => &["type", "description", "title"],
        _ => &[],
    }
}

const TYPES: &str = "object, array, string, number, integer or boolean";

/// Reads a declaration at `at` (`surfaces[1].state`); every problem with it otherwise.
pub fn read(value: &Value, at: &str) -> Result<Schema, Vec<String>> {
    let mut problems = Vec::new();
    let schema = node(value, at, 1, &mut problems);
    match schema {
        Some(schema) if problems.is_empty() => Ok(schema),
        _ => Err(problems),
    }
}

fn whole(value: &Value) -> Option<u64> {
    value.as_u64()
}

fn node(value: &Value, at: &str, depth: usize, problems: &mut Vec<String>) -> Option<Schema> {
    let Some(fields) = value.as_object() else {
        problems.push(format!("{at} is a schema: an object with a type"));
        return None;
    };
    if depth > MOST_DEPTH {
        problems.push(format!("{at} is nested more than {MOST_DEPTH} levels deep"));
        return None;
    }
    let kind = match fields.get("type") {
        Some(Value::String(kind)) if !keywords(kind).is_empty() => kind.as_str(),
        // An enum alone is a word from a list.
        None if fields.contains_key("enum") => "string",
        _ => {
            problems.push(format!("{at}.type is {TYPES}"));
            return None;
        }
    };
    let before = problems.len();
    for key in fields.keys() {
        if !keywords(kind).contains(&key.as_str()) {
            problems.push(format!(
                "{at}: {key} isn't a keyword this Spade reads for {kind}"
            ));
        }
    }
    words_for_people(fields, at, problems);
    let schema = match kind {
        "object" => object(fields, at, depth, problems),
        "array" => array(fields, at, depth, problems),
        "string" => text(fields, at, problems),
        "number" | "integer" => number(fields, at, kind == "integer", problems),
        _ => Some(Schema::Boolean),
    };
    (problems.len() == before).then_some(schema).flatten()
}

fn words_for_people(fields: &Map<String, Value>, at: &str, problems: &mut Vec<String>) {
    for (key, most) in [("description", ABOUT_CHARS), ("title", TITLE_CHARS)] {
        match fields.get(key) {
            None => {}
            Some(Value::String(text)) if text.chars().count() <= most => {}
            Some(_) => problems.push(format!("{at}.{key} is text of at most {most} characters")),
        }
    }
}

/// A field's name: what a page and a bot write it as.
fn field_name(name: &str) -> bool {
    name.len() <= 64
        && name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn object(
    fields: &Map<String, Value>,
    at: &str,
    depth: usize,
    problems: &mut Vec<String>,
) -> Option<Schema> {
    let Some(listed) = fields.get("properties").and_then(Value::as_object) else {
        problems.push(format!("{at}.properties names the object's fields"));
        return None;
    };
    if listed.len() > MOST_PROPERTIES {
        problems.push(format!(
            "{at}.properties has at most {MOST_PROPERTIES} fields"
        ));
        return None;
    }
    let mut properties = BTreeMap::new();
    for (name, value) in listed {
        if !field_name(name) {
            problems.push(format!(
                "{at}.properties names fields with letters, digits and underscores"
            ));
            continue;
        }
        if let Some(schema) = node(
            value,
            &format!("{at}.properties.{name}"),
            depth + 1,
            problems,
        ) {
            properties.insert(name.clone(), schema);
        }
    }
    let mut required = BTreeSet::new();
    match fields.get("required") {
        None => {}
        Some(Value::Array(names)) => {
            for name in names {
                match name.as_str() {
                    Some(name) if listed.contains_key(name) => {
                        required.insert(name.to_owned());
                    }
                    _ => {
                        problems.push(format!("{at}.required names its own properties"));
                        break;
                    }
                }
            }
        }
        Some(_) => problems.push(format!("{at}.required names its own properties")),
    }
    Some(Schema::Object {
        properties,
        required,
    })
}

fn array(
    fields: &Map<String, Value>,
    at: &str,
    depth: usize,
    problems: &mut Vec<String>,
) -> Option<Schema> {
    let max_items = match fields.get("maxItems").and_then(whole) {
        Some(most) if (1..=MOST_ITEMS).contains(&most) => most,
        _ => {
            problems.push(format!("{at}.maxItems bounds the list (1 to {MOST_ITEMS})"));
            0
        }
    };
    let min_items = match fields.get("minItems") {
        None => 0,
        Some(value) => match whole(value) {
            Some(least) if least <= max_items => least,
            _ => {
                problems.push(format!("{at}.minItems is a count no more than maxItems"));
                0
            }
        },
    };
    let Some(items) = fields.get("items") else {
        problems.push(format!("{at}.items is the schema of each item"));
        return None;
    };
    let items = node(items, &format!("{at}.items"), depth + 1, problems)?;
    Some(Schema::Array {
        items: Box::new(items),
        min_items,
        max_items,
    })
}

fn text(fields: &Map<String, Value>, at: &str, problems: &mut Vec<String>) -> Option<Schema> {
    if let Some(words) = fields.get("enum") {
        let listed: Option<Vec<String>> = words.as_array().and_then(|items| {
            items
                .iter()
                .map(|w| {
                    w.as_str()
                        .filter(|w| !w.is_empty() && w.chars().count() <= WORD_CHARS)
                        .map(str::to_owned)
                })
                .collect()
        });
        return match listed {
            Some(words) if !words.is_empty() && words.len() <= MOST_WORDS => {
                if fields.contains_key("maxLength") || fields.contains_key("minLength") {
                    problems.push(format!("{at}: an enum's words need no length"));
                }
                Some(Schema::Enum(words))
            }
            _ => {
                problems.push(format!(
                    "{at}.enum lists 1 to {MOST_WORDS} words, each at most {WORD_CHARS} characters"
                ));
                None
            }
        };
    }
    let max_length = match fields.get("maxLength").and_then(whole) {
        Some(most) if (1..=MOST_TEXT).contains(&most) => most,
        _ => {
            problems.push(format!("{at}.maxLength bounds the text (1 to {MOST_TEXT})"));
            return None;
        }
    };
    let min_length = match fields.get("minLength") {
        None => 0,
        Some(value) => match whole(value) {
            Some(least) if least <= max_length => least,
            _ => {
                problems.push(format!("{at}.minLength is a length no more than maxLength"));
                0
            }
        },
    };
    Some(Schema::String {
        min_length,
        max_length,
    })
}

fn number(
    fields: &Map<String, Value>,
    at: &str,
    integer: bool,
    problems: &mut Vec<String>,
) -> Option<Schema> {
    let mut bound = |key: &str| match fields.get(key) {
        None => None,
        Some(value) => match value.as_f64() {
            Some(n) => Some(n),
            None => {
                problems.push(format!("{at}.{key} is a number"));
                None
            }
        },
    };
    let (minimum, maximum) = (bound("minimum"), bound("maximum"));
    if let (Some(least), Some(most)) = (minimum, maximum)
        && least > most
    {
        problems.push(format!("{at}.minimum is no more than its maximum"));
    }
    Some(Schema::Number {
        integer,
        minimum,
        maximum,
    })
}

/// What `data` breaks of `schema`, each at its place under `at` (`data.trips[0].to`); none when
/// it fits. The list stops after twenty, with how many more there were.
pub fn check(schema: &Schema, data: &Value, at: &str) -> Vec<Problem> {
    let mut problems = Vec::new();
    fits(schema, data, at, &mut problems);
    if problems.len() > MOST_PROBLEMS {
        let more = problems.len() - MOST_PROBLEMS;
        problems.truncate(MOST_PROBLEMS);
        problems.push(Problem {
            at: String::new(),
            why: format!("and {more} more"),
        });
    }
    problems
}

fn problem(problems: &mut Vec<Problem>, at: &str, why: impl Into<String>) {
    problems.push(Problem {
        at: at.to_owned(),
        why: why.into(),
    });
}

fn fits(schema: &Schema, data: &Value, at: &str, problems: &mut Vec<Problem>) {
    match schema {
        Schema::Object {
            properties,
            required,
        } => {
            let Some(fields) = data.as_object() else {
                return problem(problems, at, "is an object");
            };
            for (name, value) in fields {
                match properties.get(name) {
                    Some(schema) => fits(schema, value, &format!("{at}.{name}"), problems),
                    None => problem(problems, &format!("{at}.{name}"), "isn't one of its fields"),
                }
            }
            for name in required {
                if !fields.contains_key(name) {
                    problem(problems, &format!("{at}.{name}"), "is needed");
                }
            }
        }
        Schema::Array {
            items,
            min_items,
            max_items,
        } => {
            let Some(list) = data.as_array() else {
                return problem(problems, at, "is a list");
            };
            let count = list.len() as u64;
            if count > *max_items {
                problem(problems, at, format!("has at most {max_items} items"));
            } else if count < *min_items {
                problem(problems, at, format!("has at least {min_items} items"));
            }
            for (i, item) in list.iter().enumerate().take(*max_items as usize) {
                fits(items, item, &format!("{at}[{i}]"), problems);
            }
        }
        Schema::String {
            min_length,
            max_length,
        } => {
            let Some(text) = data.as_str() else {
                return problem(problems, at, "is text");
            };
            let length = text.chars().count() as u64;
            if length > *max_length {
                problem(problems, at, format!("is at most {max_length} characters"));
            } else if length < *min_length {
                problem(problems, at, format!("is at least {min_length} characters"));
            }
        }
        Schema::Enum(words) => {
            if !data.as_str().is_some_and(|w| words.iter().any(|x| x == w)) {
                problem(problems, at, format!("is one of {}", words.join(", ")));
            }
        }
        Schema::Number {
            integer,
            minimum,
            maximum,
        } => {
            let Some(n) = data.as_f64() else {
                return problem(problems, at, "is a number");
            };
            if *integer && n.fract() != 0.0 {
                problem(problems, at, "is a whole number");
            }
            if let Some(least) = minimum
                && n < *least
            {
                problem(problems, at, format!("is at least {least}"));
            }
            if let Some(most) = maximum
                && n > *most
            {
                problem(problems, at, format!("is at most {most}"));
            }
        }
        Schema::Boolean => {
            if !data.is_boolean() {
                problem(problems, at, "is true or false");
            }
        }
    }
}

#[cfg(test)]
mod tests;
