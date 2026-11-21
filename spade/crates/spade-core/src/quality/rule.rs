//! A `schema` check's rule (ADR 0204 §3): a bounded JSON Schema run on a result beyond the
//! contract's or card's own. The contract's schema already bounds every value, so a rule only
//! narrows: no keyword is required, `type` may be left out, and `pattern` is allowed. Like the
//! contract subset (`crate::schema`), any keyword outside it refuses the rule, so a rule never
//! means more than the readers check. The marketplace reads rules the same way
//! (`packages/marketplace/src/check-rule.ts`), held to it by the conformance suite's
//! `package/check-rules.json`. Pure.
//!
//! A `pattern` is written in the part of regular expressions that Rust's `regex` and
//! JavaScript's `RegExp` (with the `u` and `s` flags) read the same way: literals, `.`, `^`, `$`,
//! `|`, groups, `*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}` (at most 1,000) and classes with ranges.
//! A backslash escapes only `^ $ \ . * + ? ( ) [ ] { } | /` (and `-` in a class); `\d`, `\w`,
//! `\s`, `\b`, `(?…)`, a `[` inside a class, `&&`, `--` and `~~` in a class, an empty class and an
//! unescaped `]` or `}` outside one are refused. It matches anywhere in the text unless anchored.

use std::collections::BTreeMap;

use regex::Regex;
use serde_json::{Map, Value};

use crate::schema::{
    DESCRIPTION_CHARS, ENUM_CHARS, LONGEST_STRING, MOST_DEPTH, MOST_ENUM, MOST_FIELDS, MOST_ITEMS,
    MOST_SCHEMA_BYTES, Misfit,
};

/// A pattern's longest text, in characters.
pub const PATTERN_CHARS: usize = 200;
/// The largest count a pattern's `{n,m}` names.
pub const MOST_REPEAT: u32 = 1_000;

/// The keywords a rule takes, by the kind of value they narrow.
pub const OBJECT_KEYWORDS: [&str; 2] = ["properties", "required"];
pub const STRING_KEYWORDS: [&str; 4] = ["minLength", "maxLength", "enum", "pattern"];
pub const NUMBER_KEYWORDS: [&str; 2] = ["minimum", "maximum"];
pub const ARRAY_KEYWORDS: [&str; 3] = ["items", "minItems", "maxItems"];
/// Every rule may also say these.
pub const COMMON: [&str; 3] = ["type", "description", "title"];
const TYPES: [&str; 6] = ["object", "string", "number", "integer", "boolean", "array"];

/// One rule, read.
#[derive(Debug, Clone)]
pub struct Rule {
    kind: Option<String>,
    narrows: Narrows,
}

#[derive(Debug, Clone)]
enum Narrows {
    Nothing,
    Object {
        fields: BTreeMap<String, Rule>,
        required: Vec<String>,
    },
    String {
        min: Option<u64>,
        max: Option<u64>,
        one_of: Option<Vec<String>>,
        pattern: Option<(String, Regex)>,
    },
    Number {
        min: Option<f64>,
        max: Option<f64>,
    },
    Array {
        items: Option<Box<Rule>>,
        min: Option<u64>,
        max: Option<u64>,
    },
}

/// Reads `value` as a rule; every problem at its place (`at` names the rule, `checks[0].rule`).
pub fn read(value: &Value, at: &str) -> Result<Rule, Vec<String>> {
    if value.to_string().len() > MOST_SCHEMA_BYTES {
        return Err(vec![format!(
            "{at} is longer than {} KiB",
            MOST_SCHEMA_BYTES / 1024
        )]);
    }
    let mut problems = Vec::new();
    let rule = node(value, at, 1, &mut problems);
    match rule {
        Some(rule) if problems.is_empty() => Ok(rule),
        _ => Err(problems),
    }
}

/// The kind of value a keyword narrows.
fn kind_of(keyword: &str) -> Option<&'static str> {
    if OBJECT_KEYWORDS.contains(&keyword) {
        Some("object")
    } else if STRING_KEYWORDS.contains(&keyword) {
        Some("string")
    } else if NUMBER_KEYWORDS.contains(&keyword) {
        Some("number")
    } else if ARRAY_KEYWORDS.contains(&keyword) {
        Some("array")
    } else {
        None
    }
}

fn node(value: &Value, at: &str, depth: usize, out: &mut Vec<String>) -> Option<Rule> {
    if depth > MOST_DEPTH {
        out.push(format!("{at}: a rule nests at most {MOST_DEPTH} levels"));
        return None;
    }
    let Some(fields) = value.as_object() else {
        out.push(format!("{at} is a rule object"));
        return None;
    };
    let before = out.len();
    let mut narrowed: Option<&'static str> = None;
    for key in fields.keys() {
        if COMMON.contains(&key.as_str()) {
            continue;
        }
        match kind_of(key) {
            None => out.push(format!("{at}: {key:?} isn't in the rule subset checks use")),
            Some(kind) if narrowed.is_some_and(|k| k != kind) => {
                out.push(format!("{at} mixes keywords of different types"));
            }
            Some(kind) => narrowed = Some(kind),
        }
    }
    for key in ["description", "title"] {
        let fits = |v: &Value| {
            v.as_str()
                .is_some_and(|t| t.chars().count() <= DESCRIPTION_CHARS)
        };
        if fields.get(key).is_some_and(|v| !fits(v)) {
            out.push(format!(
                "{at}.{key} is text of at most {DESCRIPTION_CHARS} characters"
            ));
        }
    }
    let kind = match fields.get("type") {
        None => None,
        Some(Value::String(kind)) if TYPES.contains(&kind.as_str()) => Some(kind.clone()),
        Some(_) => {
            out.push(format!(
                "{at}.type is object, string, number, integer, boolean or array"
            ));
            None
        }
    };
    if let (Some(kind), Some(narrowed)) = (&kind, narrowed) {
        let same = kind == narrowed || (kind == "integer" && narrowed == "number");
        if !same {
            out.push(format!(
                "{at}: a {kind} takes none of the {narrowed} keywords"
            ));
        }
    }
    if out.len() > before {
        return None;
    }
    let narrows = match narrowed {
        None => Narrows::Nothing,
        Some("object") => object(fields, at, depth, out)?,
        Some("string") => string(fields, at, out)?,
        Some("number") => {
            let (min, max) = (
                number(fields, "minimum", at, out),
                number(fields, "maximum", at, out),
            );
            if let (Some(min), Some(max)) = (min, max)
                && min > max
            {
                out.push(format!("{at}: minimum is more than maximum"));
            }
            Narrows::Number { min, max }
        }
        _ => {
            let min = count(fields, "minItems", MOST_ITEMS, at, out);
            let max = count(fields, "maxItems", MOST_ITEMS, at, out);
            if let (Some(min), Some(max)) = (min, max)
                && min > max
            {
                out.push(format!("{at}: minItems is more than maxItems"));
            }
            let items = match fields.get("items") {
                None => None,
                Some(items) => Some(Box::new(node(
                    items,
                    &format!("{at}.items"),
                    depth + 1,
                    out,
                )?)),
            };
            Narrows::Array { items, min, max }
        }
    };
    (out.len() == before).then_some(Rule { kind, narrows })
}

fn number(fields: &Map<String, Value>, key: &str, at: &str, out: &mut Vec<String>) -> Option<f64> {
    match fields.get(key) {
        None => None,
        Some(n) if n.is_number() => n.as_f64(),
        Some(_) => {
            out.push(format!("{at}.{key} is a number"));
            None
        }
    }
}

fn count(
    fields: &Map<String, Value>,
    key: &str,
    most: u64,
    at: &str,
    out: &mut Vec<String>,
) -> Option<u64> {
    let value = fields.get(key)?;
    match value.as_u64() {
        Some(n) if n <= most => Some(n),
        _ => {
            out.push(format!("{at}.{key} is a whole number up to {most}"));
            None
        }
    }
}

fn field_name(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn object(
    fields: &Map<String, Value>,
    at: &str,
    depth: usize,
    out: &mut Vec<String>,
) -> Option<Narrows> {
    let mut read = BTreeMap::new();
    match fields.get("properties") {
        None => {}
        Some(Value::Object(properties)) if properties.len() <= MOST_FIELDS => {
            for (name, value) in properties {
                if !field_name(name) {
                    out.push(format!(
                        "{at}.properties: {name:?} is a field name of 1 to 64 letters, digits and _"
                    ));
                    continue;
                }
                if let Some(rule) = node(value, &format!("{at}.{name}"), depth + 1, out) {
                    read.insert(name.clone(), rule);
                }
            }
        }
        Some(_) => out.push(format!(
            "{at}.properties names at most {MOST_FIELDS} fields"
        )),
    }
    let required = match fields.get("required") {
        None => Vec::new(),
        Some(Value::Array(names))
            if names.len() <= MOST_FIELDS
                && names.iter().all(|n| n.as_str().is_some_and(field_name)) =>
        {
            names
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        }
        Some(_) => {
            out.push(format!("{at}.required is a list of field names"));
            Vec::new()
        }
    };
    Some(Narrows::Object {
        fields: read,
        required,
    })
}

fn string(fields: &Map<String, Value>, at: &str, out: &mut Vec<String>) -> Option<Narrows> {
    let min = count(fields, "minLength", LONGEST_STRING, at, out);
    let max = count(fields, "maxLength", LONGEST_STRING, at, out);
    if let (Some(min), Some(max)) = (min, max)
        && min > max
    {
        out.push(format!("{at}: minLength is more than maxLength"));
    }
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
                out.push(format!(
                    "{at}.enum lists words of at most {ENUM_CHARS} characters"
                ));
            }
            words
        }
        Some(_) => {
            out.push(format!("{at}.enum lists 1 to {MOST_ENUM} words"));
            None
        }
    };
    let pattern = match fields.get("pattern") {
        None => None,
        Some(Value::String(text)) => match pattern_problem(text) {
            Some(why) => {
                out.push(format!("{at}.pattern {why}"));
                None
            }
            // `(?s)`: `.` takes any character, as JavaScript's `s` flag reads it.
            None => match Regex::new(&format!("(?s){text}")) {
                Ok(regex) => Some((text.clone(), regex)),
                Err(_) => {
                    out.push(format!("{at}.pattern isn't a pattern this subset reads"));
                    None
                }
            },
        },
        Some(_) => {
            out.push(format!("{at}.pattern is text"));
            None
        }
    };
    Some(Narrows::String {
        min,
        max,
        one_of,
        pattern,
    })
}

/// The characters a backslash escapes outside a class, and inside one.
const ESCAPED: &str = "^$\\.*+?()[]{}|/";
const ESCAPED_IN_CLASS: &str = "^$\\.*+?()[]{}|/-";

/// Why `pattern` is outside the subset both regex readers agree on; `None` when it is in it.
pub fn pattern_problem(pattern: &str) -> Option<String> {
    let chars: Vec<char> = pattern.chars().collect();
    if chars.is_empty() || chars.len() > PATTERN_CHARS {
        return Some(format!("is 1 to {PATTERN_CHARS} characters"));
    }
    let mut at = 0;
    let mut in_class = false;
    while at < chars.len() {
        let c = chars[at];
        if c == '\\' {
            let escaped = if in_class { ESCAPED_IN_CLASS } else { ESCAPED };
            match chars.get(at + 1) {
                Some(next) if escaped.contains(*next) => at += 2,
                Some(next) => {
                    return Some(format!(
                        "escapes only punctuation: write \\{next} another way (a class like [0-9] for \\d)"
                    ));
                }
                None => return Some("ends in a lone backslash".to_owned()),
            }
            continue;
        }
        if in_class {
            match c {
                ']' => in_class = false,
                '[' => return Some("escapes a [ inside a class".to_owned()),
                '&' | '-' | '~' if chars.get(at + 1) == Some(&c) => {
                    return Some(format!("doesn't use {c}{c} inside a class"));
                }
                _ => {}
            }
            at += 1;
            continue;
        }
        match c {
            '[' => {
                let mut next = at + 1;
                if chars.get(next) == Some(&'^') {
                    next += 1;
                }
                if chars.get(next) == Some(&']') {
                    return Some("has no empty class".to_owned());
                }
                in_class = true;
                at = next;
                continue;
            }
            ']' | '}' => return Some(format!("escapes a {c} outside a class")),
            '(' if chars.get(at + 1) == Some(&'?') => {
                return Some("has no (?…) groups".to_owned());
            }
            '{' => {
                let close = chars[at..].iter().position(|&c| c == '}');
                let inside: Option<String> =
                    close.map(|close| chars[at + 1..at + close].iter().collect());
                let Some(close) = close.filter(|_| inside.as_deref().is_some_and(repeat)) else {
                    return Some(format!(
                        "repeats with {{n}}, {{n,}} or {{n,m}}, each at most {MOST_REPEAT}; escape a {{ meant as text"
                    ));
                };
                at += close + 1;
                continue;
            }
            _ => {}
        }
        at += 1;
    }
    in_class.then(|| "closes every class it opens".to_owned())
}

fn repeat(inside: &str) -> bool {
    let whole = |t: &str| {
        !t.is_empty()
            && t.len() <= 4
            && t.chars().all(|c| c.is_ascii_digit())
            && t.parse::<u32>().is_ok_and(|n| n <= MOST_REPEAT)
    };
    match inside.split_once(',') {
        None => whole(inside),
        Some((low, "")) => whole(low),
        Some((low, high)) => {
            whole(low) && whole(high) && low.parse::<u32>().ok() <= high.parse::<u32>().ok()
        }
    }
}

impl Rule {
    /// Every place `value` misses the rule, under `at` (`output`); empty when it holds.
    pub fn check(&self, value: &Value, at: &str) -> Vec<Misfit> {
        let mut out = Vec::new();
        self.walk(value, at, &mut out);
        out
    }

    fn walk(&self, value: &Value, at: &str, out: &mut Vec<Misfit>) {
        if out.len() >= 20 {
            return;
        }
        let miss = |out: &mut Vec<Misfit>, why: String| {
            out.push(Misfit {
                at: at.to_owned(),
                why,
            });
        };
        if let Some(kind) = &self.kind
            && !of_kind(kind, value)
        {
            miss(out, format!("is {}", kind_words(kind)));
            return;
        }
        match (&self.narrows, value) {
            (Narrows::Nothing, _) => {}
            (Narrows::Object { fields, required }, Value::Object(given)) => {
                for name in required {
                    if !given.contains_key(name) {
                        out.push(Misfit {
                            at: format!("{at}.{name}"),
                            why: "is missing".to_owned(),
                        });
                    }
                }
                for (name, rule) in fields {
                    if let Some(item) = given.get(name) {
                        rule.walk(item, &format!("{at}.{name}"), out);
                    }
                }
            }
            (
                Narrows::String {
                    min,
                    max,
                    one_of,
                    pattern,
                },
                Value::String(text),
            ) => {
                let length = text.chars().count() as u64;
                if let Some(words) = one_of
                    && !words.iter().any(|w| w == text)
                {
                    miss(out, format!("is one of {}", words.join(", ")));
                } else if max.is_some_and(|max| length > max) {
                    miss(out, format!("is at most {} characters", max.unwrap_or(0)));
                } else if min.is_some_and(|min| length < min) {
                    miss(out, format!("is at least {} characters", min.unwrap_or(0)));
                } else if let Some((written, regex)) = pattern
                    && !regex.is_match(text)
                {
                    miss(out, format!("doesn't match {written}"));
                }
            }
            (Narrows::Number { min, max }, Value::Number(n)) => {
                let x = n.as_f64().unwrap_or(f64::NAN);
                if min.is_some_and(|min| x < min) {
                    miss(out, format!("is at least {}", min.unwrap_or_default()));
                } else if max.is_some_and(|max| x > max) {
                    miss(out, format!("is at most {}", max.unwrap_or_default()));
                }
            }
            (Narrows::Array { items, min, max }, Value::Array(given)) => {
                let length = given.len() as u64;
                if max.is_some_and(|max| length > max) {
                    miss(out, format!("holds at most {} items", max.unwrap_or(0)));
                } else if min.is_some_and(|min| length < min) {
                    miss(out, format!("holds at least {} items", min.unwrap_or(0)));
                }
                if let Some(items) = items {
                    for (i, item) in given.iter().enumerate().take(MOST_ITEMS as usize) {
                        items.walk(item, &format!("{at}[{i}]"), out);
                    }
                }
            }
            (Narrows::Object { .. }, _) => miss(out, "is an object".to_owned()),
            (Narrows::String { .. }, _) => miss(out, "is text".to_owned()),
            (Narrows::Number { .. }, _) => miss(out, "is a number".to_owned()),
            (Narrows::Array { .. }, _) => miss(out, "is a list".to_owned()),
        }
    }
}

fn of_kind(kind: &str, value: &Value) -> bool {
    match kind {
        "object" => value.is_object(),
        "string" => value.is_string(),
        "number" => value.is_number(),
        // `3.0` is whole, as JavaScript reads it.
        "integer" => value.as_f64().is_some_and(|x| x.fract() == 0.0),
        "boolean" => value.is_boolean(),
        _ => value.is_array(),
    }
}

fn kind_words(kind: &str) -> &'static str {
    match kind {
        "object" => "an object",
        "string" => "text",
        "number" => "a number",
        "integer" => "a whole number",
        "boolean" => "true or false",
        _ => "a list",
    }
}

#[cfg(test)]
mod tests;
