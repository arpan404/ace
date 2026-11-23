// SPDX-License-Identifier: Apache-2.0
//! Provider errors (the port of `provider-error.ts`).
//! Pure mapping from Claude's error code and text to an agent error.

use ace_json::{Map, Value};

pub fn claude_error(code: &str, text: &str, model: Option<&str>) -> Value {
    let mut reported = model.map(|s| s.to_owned());
    let start = text.find('{').unwrap_or(text.len());
    let json = &text[start..];
    if let Ok(parsed) = ace_json::parse(json)
        && let Some(Value::String(m)) = parsed.get("model")
        && !m.is_empty()
    {
        reported = Some(String::from(m.clone()));
    }
    if code == "unrecognized_model" || code == "model_not_found" {
        let title = match &reported {
            Some(m) if !m.is_empty() => {
                format!("Claude Code doesn't recognise the model \"{m}\"")
            }
            _ => "Claude Code doesn't recognise the model".to_owned(),
        };
        return error_value("provider", "model_not_found", &title, &title, text, None);
    }
    let kind = if code == "authentication_failed" || code == "auth" {
        "auth"
    } else if code == "billing_error" || code == "rate_limit" || code == "quota" {
        "quota"
    } else if code == "network" {
        "network"
    } else {
        "provider"
    };
    let title = if kind == "auth" {
        "Not signed in to Claude Code".to_owned()
    } else if kind == "quota" {
        "Usage limit reached".to_owned()
    } else if kind == "network" {
        "Network trouble".to_owned()
    } else if code == "context_length" {
        "Conversation is too long".to_owned()
    } else if code == "overloaded_error" || is_overloaded(text) {
        "Claude is busy. Try again shortly.".to_owned()
    } else if code == "server_error" || is_server_error(text) {
        "Claude had a server error. Try again shortly.".to_owned()
    } else if code == "max_output_tokens" || code == "output_limit" {
        "Claude reached its response limit. Ask it to continue.".to_owned()
    } else {
        "Claude Code execution failed. Try again.".to_owned()
    };
    let out_code = if kind == "auth" {
        "auth"
    } else if code == "billing_error" {
        "quota"
    } else {
        code
    };
    error_value(kind, out_code, &title, &title, text, None)
}

fn is_overloaded(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("api error: 529") || lower.contains("overloaded")
}

fn is_server_error(text: &str) -> bool {
    // The TypeScript checks /API Error: 5\d\d/ (case-sensitive).
    let needle = "API Error: 5";
    let mut start = 0;
    while let Some(at) = text[start..].find(needle) {
        let base = start + at + needle.len();
        let tail: String = text[base..].chars().take(2).collect();
        if tail.len() == 2 && tail.chars().all(|c| c.is_ascii_digit()) {
            return true;
        }
        start = start + at + 1;
    }
    false
}

fn error_value(
    kind: &str,
    code: &str,
    title: &str,
    message: &str,
    detail: &str,
    details: Option<Value>,
) -> Value {
    let mut map = Map::with_capacity(6);
    map.insert("kind".to_owned(), Value::from(kind.to_owned()));
    map.insert("code".to_owned(), Value::from(code.to_owned()));
    map.insert("title".to_owned(), Value::from(title.to_owned()));
    map.insert("message".to_owned(), Value::from(message.to_owned()));
    map.insert("detail".to_owned(), Value::from(detail.to_owned()));
    if let Some(d) = details {
        map.insert("details".to_owned(), d);
    }
    Value::Object(map)
}

pub fn with_details(mut error: Value, details: Value) -> Value {
    if let Value::Object(map) = &mut error {
        map.insert("details".to_owned(), details);
    }
    error
}
