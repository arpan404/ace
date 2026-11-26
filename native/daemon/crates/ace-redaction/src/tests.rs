// SPDX-License-Identifier: Apache-2.0
//! The cases of `packages/redaction/src`'s eleven test files, moved with the module (ADR 0224
//! §11, F0). One difference in form only: a Rust `Context` cannot hold a throwing getter, so
//! `index.test.ts`'s "context cannot be read" case has no analogue here.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use super::{Context, Redactor};

fn context(env: &[(&str, &str)]) -> Context {
    Context {
        env: env
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect(),
        ..Context::default()
    }
}

fn text(redactor: &Redactor, value: &str) -> String {
    redactor.text(value)
}

fn record(redactor: &Redactor, value: &str) -> String {
    redactor.record(&[], value)
}

fn parsed(redactor: &Redactor, value: &str) -> ace_json::Value {
    ace_json::parse(&record(redactor, value)).expect("redacted records stay valid JSON")
}

fn streamed(redactor: &Redactor, value: &str) -> String {
    redactor
        .stream(value)
        .expect("the test's text fits the chunk budget")
        .join("")
}

// index.test.ts

mod diagnostics;
mod index;
mod prose;
mod records;
mod streams;

fn quoted(text: &str) -> String {
    ace_json::to_string(&ace_json::Value::from(text))
}

fn clean_value_payload(clean: &str) -> ace_json::Value {
    let value = ace_json::parse(clean).expect("valid JSON");
    value
        .as_object()
        .and_then(|object| object.get("payload").cloned())
        .expect("a payload")
}

/// A JSON object literal from pairs, with `JSON.stringify`'s escaping of each value.
fn serde_like(pairs: &[(&str, &str)]) -> String {
    let mut object = ace_json::Map::new();
    for (key, value) in pairs {
        object.insert(*key, ace_json::Value::from(*value));
    }
    ace_json::to_string(&ace_json::Value::Object(object))
}
