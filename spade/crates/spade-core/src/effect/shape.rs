//! What a connected app's call can reach through its arguments (ADR 0202, amendment 5): a tool
//! whose input names a destination (a URL, a host, an endpoint, a webhook, a recipient, an email
//! address) can send data anywhere, and one that takes text it runs (SQL, code, a script, an
//! expression) can change anything. Neither is a plain read or an ordinary write, whatever its
//! name says: the reviewer judges it, the person decides it under untrusted content, and a
//! package's ceiling needs `network` for it. A search's `query` is search text unless it reads
//! as a statement that changes something. Pure: property names and values are matched against
//! fixed words only.

use serde_json::Value;

use super::named::words;

/// What a call's arguments can reach.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// Only the app's own content, as the tool names it.
    Plain,
    /// A destination the caller picks: a URL, host, endpoint, webhook, recipient or address.
    Outward,
    /// Text the app runs: SQL, code, a script, an expression, or a query that changes things.
    Code,
}

/// Argument words that name a destination.
const OUTWARD: &[&str] = &[
    "url",
    "urls",
    "uri",
    "uris",
    "href",
    "host",
    "hostname",
    "domain",
    "endpoint",
    "webhook",
    "callback",
    "to",
    "recipient",
    "recipients",
    "email",
    "emails",
    "cc",
    "bcc",
    "phone",
    "destination",
];

/// Argument words that name text the app runs.
const CODE: &[&str] = &[
    "sql",
    "code",
    "script",
    "expression",
    "expr",
    "eval",
    "command",
    "cmd",
    "statement",
    "stmt",
    "javascript",
    "js",
    "python",
    "shell",
    "formula",
    "program",
];

/// Argument words that are a query: search text for a search, else text the app runs.
const QUERY: &[&str] = &["query", "q", "querystring"];

/// Verbs whose `query` is search text.
const SEARCHES: &[&str] = &["search", "find", "lookup", "look"];

/// Words a query that changes something holds.
const STATEMENTS: &[&str] = &[
    "update", "insert", "delete", "drop", "alter", "create", "truncate", "grant", "revoke",
    "merge", "replace", "exec", "execute", "call", "upsert", "set", "mutation",
];

/// Tool-name words that name a destination: `fetch_url`, `call_webhook`.
const OUTWARD_NAMES: &[&str] = &[
    "url", "urls", "uri", "http", "https", "webhook", "endpoint", "curl", "wget",
];

/// Every property name in `schema` (its `properties`, nested objects, array items and their
/// `anyOf`/`oneOf`/`allOf` branches) and every key in `arguments`, nested ones included.
fn keys(value: &Value, out: &mut Vec<String>, depth: usize) {
    if depth > 16 {
        return;
    }
    match value {
        Value::Object(map) => {
            for (key, inner) in map {
                if !matches!(
                    key.as_str(),
                    "properties"
                        | "items"
                        | "anyOf"
                        | "oneOf"
                        | "allOf"
                        | "additionalProperties"
                        | "patternProperties"
                        | "$defs"
                        | "definitions"
                        | "type"
                        | "description"
                        | "required"
                        | "enum"
                        | "default"
                        | "title"
                        | "format"
                ) {
                    out.push(key.clone());
                }
                keys(inner, out, depth + 1);
            }
        }
        Value::Array(items) => items.iter().for_each(|item| keys(item, out, depth + 1)),
        _ => {}
    }
}

/// Every string value under a key that is a query, anywhere in `arguments`.
fn queries<'a>(value: &'a Value, out: &mut Vec<&'a str>, depth: usize) {
    if depth > 16 {
        return;
    }
    match value {
        Value::Object(map) => {
            for (key, inner) in map {
                let named = words(key).iter().any(|word| QUERY.contains(&word.as_str()));
                match inner {
                    Value::String(text) if named => out.push(text),
                    _ => queries(inner, out, depth + 1),
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|item| queries(item, out, depth + 1)),
        _ => {}
    }
}

/// What a call of the tool `name`, with input `schema`, given `arguments`, can reach.
pub fn shape(name: &str, schema: &Value, arguments: &Value) -> Shape {
    let tool = words(name);
    if tool
        .iter()
        .any(|word| OUTWARD_NAMES.contains(&word.as_str()))
    {
        return Shape::Outward;
    }
    let mut found = Vec::new();
    keys(schema, &mut found, 0);
    keys(arguments, &mut found, 0);
    let parts: Vec<Vec<String>> = found.iter().map(|key| words(key)).collect();
    let any = |set: &[&str]| {
        parts
            .iter()
            .any(|key| key.iter().any(|word| set.contains(&word.as_str())))
    };
    if any(OUTWARD)
        || found.iter().any(|key| {
            let key = key.to_lowercase();
            ["webhook", "endpoint", "callback", "recipient", "hostname"]
                .iter()
                .any(|stem| key.contains(stem))
        })
    {
        return Shape::Outward;
    }
    if any(CODE) {
        return Shape::Code;
    }
    if any(QUERY) {
        let search = tool.iter().any(|word| SEARCHES.contains(&word.as_str()));
        let mut given = Vec::new();
        queries(arguments, &mut given, 0);
        let changes = given.iter().any(|text| {
            words(text)
                .iter()
                .any(|word| STATEMENTS.contains(&word.as_str()))
        });
        if !search || changes {
            return Shape::Code;
        }
    }
    Shape::Plain
}

#[cfg(test)]
#[path = "shape_tests.rs"]
mod tests;
