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

/// Tool-name words that name a destination, besides every argument word that does: `fetch_url`.
const OUTWARD_NAMES: &[&str] = &["http", "https", "curl", "wget"];

/// Destinations inside a longer word, of a name or an argument.
const OUTWARD_STEMS: &[&str] = &["webhook", "endpoint", "callback", "recipient", "hostname"];

/// How deep a schema or arguments are read; one deeper is unresolved, never taken as plain.
const DEEPEST: usize = 16;

/// Every property name in `schema` (its `properties`, nested objects, array items and their
/// `anyOf`/`oneOf`/`allOf` branches) and every key in `arguments`, nested ones included. `false`
/// when it nests deeper than Spade reads.
fn keys(value: &Value, out: &mut Vec<String>, depth: usize) -> bool {
    // Anything past the depth Spade reads, a plain leaf too, is more than it can vouch for.
    if depth > DEEPEST {
        return false;
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
                if !keys(inner, out, depth + 1) {
                    return false;
                }
            }
            true
        }
        Value::Array(items) => items.iter().all(|item| keys(item, out, depth + 1)),
        _ => true,
    }
}

/// Every string under a key that is a query, anywhere in `arguments`, inside lists and objects
/// given as the query too. `false` when it nests deeper than Spade reads.
fn queries<'a>(value: &'a Value, out: &mut Vec<&'a str>, depth: usize) -> bool {
    if depth > DEEPEST {
        return false;
    }
    match value {
        Value::Object(map) => map.iter().all(|(key, inner)| {
            if words(key).iter().any(|word| QUERY.contains(&word.as_str())) {
                strings(inner, out, depth + 1)
            } else {
                queries(inner, out, depth + 1)
            }
        }),
        Value::Array(items) => items.iter().all(|item| queries(item, out, depth + 1)),
        _ => true,
    }
}

/// Every string in `value`, object keys included, at any depth Spade reads.
fn strings<'a>(value: &'a Value, out: &mut Vec<&'a str>, depth: usize) -> bool {
    if depth > DEEPEST {
        return false;
    }
    match value {
        Value::String(text) => {
            out.push(text);
            true
        }
        // An object given as a query is read whole: its keys are text the app may run too.
        Value::Object(map) => map.iter().all(|(key, inner)| {
            out.push(key);
            strings(inner, out, depth + 1)
        }),
        Value::Array(items) => items.iter().all(|item| strings(item, out, depth + 1)),
        _ => true,
    }
}

/// What a call of the tool `name`, with input `schema`, given `arguments`, can reach.
pub fn shape(name: &str, schema: &Value, arguments: &Value) -> Shape {
    let tool = words(name);
    let joined = tool.concat();
    if tool
        .iter()
        .any(|word| OUTWARD_NAMES.contains(&word.as_str()) || OUTWARD.contains(&word.as_str()))
        || OUTWARD_STEMS.iter().any(|stem| joined.contains(stem))
    {
        return Shape::Outward;
    }
    let mut found = Vec::new();
    // Too deep to read whole: what it hides can't be vouched for.
    if !keys(schema, &mut found, 0) || !keys(arguments, &mut found, 0) {
        return Shape::Code;
    }
    let parts: Vec<Vec<String>> = found.iter().map(|key| words(key)).collect();
    let any = |set: &[&str]| {
        parts
            .iter()
            .any(|key| key.iter().any(|word| set.contains(&word.as_str())))
    };
    if any(OUTWARD)
        || found.iter().any(|key| {
            let key = key.to_lowercase();
            OUTWARD_STEMS.iter().any(|stem| key.contains(stem))
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
        if !queries(arguments, &mut given, 0) {
            return Shape::Code;
        }
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
