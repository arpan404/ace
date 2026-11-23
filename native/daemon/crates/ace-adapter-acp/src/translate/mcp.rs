// SPDX-License-Identifier: Apache-2.0
//! MCP envelopes and arguments (`tools.ts` MCP half).

use ace_json::{Map, Value};

pub(crate) fn mcp_envelope(input: &Map) -> Option<Map> {
    let mut keys: Vec<&ace_json::JsString> = input.keys().filter(|key| *key != "_toolName").collect();
    keys.sort();
    if keys.is_empty() {
        return None;
    }
    let allowed = ["providerIdentifier", "toolName", "args", "arguments"];
    if !keys.iter().all(|key| allowed.contains(&key.as_str())) {
        return None;
    }
    let wrapped = input.contains_key("args") || input.contains_key("arguments");
    let named = input
        .get("providerIdentifier")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
        || input
            .get("toolName")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty());
    if wrapped || named {
        Some(input.clone())
    } else {
        None
    }
}

/// MCP call arguments: unwrapped from a recognized envelope, else the input as sent.
pub fn mcp_arguments(input: &Map) -> Value {
    let Some(envelope) = mcp_envelope(input) else {
        return Value::Object(input.clone());
    };
    if let Some(args) = envelope.get("args") {
        return args.clone();
    }
    match envelope.get("arguments") {
        Some(Value::Object(_)) => envelope.get("arguments").cloned().unwrap_or(Value::Null),
        Some(_) => {
            // Non-object arguments: the whole input stays, when the key exists.
            Value::Object(input.clone())
        }
        None => {
            // No arguments key: empty when the envelope is only names, else input.
            // TypeScript: hasOwn(envelope, "arguments") ? input : {}
            // Here None means no key, so return empty object.
            Value::Object(Map::new())
        }
    }
}
