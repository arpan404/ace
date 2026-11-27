// SPDX-License-Identifier: Apache-2.0
//! The JSON walk that decides whether a value fits a byte budget, ported from
//! `packages/mcp-server/src/json-budget.ts` (`withinJsonBudget`).
//!
//! It is checked on the parsed value, before a schema or a serializer sees it. Strings are charged
//! their UTF-8 bytes (minus the two quotes) after a quick UTF-16 length check, exactly as the
//! TypeScript does (rule 17); numbers are charged the length of their JavaScript text.

use ace_json::Value;

use crate::limits::{MAX_JSON_DEPTH, MAX_JSON_NODES};

/// A result past `maxStructuredResultBytes` (`json-budget.ts:45`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("The result was too large to return")]
pub struct ResultBudgetExceeded;

/// Whether `value` fits `limit` bytes as JSON, within the node and depth bounds.
pub fn within_json_budget(value: &Value, limit: usize) -> bool {
    let mut remaining = limit as i64;
    let mut nodes = 0_usize;
    visit(value, 0, &mut remaining, &mut nodes)
}

fn visit(value: &Value, depth: usize, remaining: &mut i64, nodes: &mut usize) -> bool {
    *nodes += 1;
    if *nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH || *remaining < 0 {
        return false;
    }
    match value {
        Value::Null => *remaining -= 4,
        Value::String(text) => {
            // `.length` counts UTF-16 units; the charge counts UTF-8 bytes.
            let units = text.len_utf16();
            if units as i64 > *remaining {
                return false;
            }
            *remaining -= 2 + text.as_str().len() as i64;
        }
        Value::Number(_) => {
            // `String(item).length`: ace-json writes JavaScript's own number text.
            let text = ace_json::to_string(value);
            *remaining -= text.len() as i64;
        }
        Value::Bool(true) => *remaining -= 4,
        Value::Bool(false) => *remaining -= 5,
        Value::Array(items) => {
            if items.len() > MAX_JSON_NODES {
                return false;
            }
            *remaining -= 2 + items.len() as i64;
            for child in items {
                if !visit(child, depth + 1, remaining, nodes) {
                    return false;
                }
            }
        }
        Value::Object(map) => {
            *remaining -= 2;
            for (key, child) in map {
                let key_value = Value::String(key.clone());
                if !visit(&key_value, depth + 1, remaining, nodes) {
                    return false;
                }
                *remaining -= 2;
                if !visit(child, depth + 1, remaining, nodes) {
                    return false;
                }
            }
        }
    }
    *remaining >= 0
}

#[cfg(test)]
mod tests {
    // The behaviour `json-budget.ts` guards, named for what it refuses.
    use super::*;
    use ace_json::parse;

    fn fits(text: &str, limit: usize) -> bool {
        within_json_budget(&parse(text).expect("valid json"), limit)
    }

    #[test]
    fn a_value_past_the_byte_bound_is_refused_and_one_exactly_at_it_passes() {
        // The walk charges structure above the serialized bytes: `{"a":"bc"}` is 10 bytes of
        // JSON and 11 of budget (an object's key costs its quotes twice, as TypeScript's does).
        assert!(fits("{\"a\":\"bc\"}", 11));
        assert!(!fits("{\"a\":\"bc\"}", 10));
        // A string's quick check is UTF-16 units, its charge UTF-8 bytes: an emoji is 2 units,
        // 4 bytes. `{"a":"😀"}` is 13 bytes.
        assert!(!fits("{\"a\":\"😀\"}", 12));
        assert!(fits("{\"a\":\"😀\"}", 13));
    }

    #[test]
    fn a_value_past_the_node_or_depth_bound_is_refused_whatever_its_bytes() {
        let wide = format!("[{}]", vec!["1"; MAX_JSON_NODES].join(","));
        assert!(!fits(&wide, 1024 * 1024));
        let mut deep = String::new();
        for _ in 0..=MAX_JSON_DEPTH {
            deep.push('[');
        }
        deep.push('1');
        for _ in 0..=MAX_JSON_DEPTH {
            deep.push(']');
        }
        assert!(!fits(&deep, 1024 * 1024));
    }

    #[test]
    fn a_result_over_the_structured_bound_is_the_public_value_error() {
        let value = parse(&format!("{{\"text\":\"{}\"}}", "x".repeat(300 * 1024))).expect("json");
        assert!(!within_json_budget(
            &value,
            crate::limits::MAX_STRUCTURED_RESULT_BYTES
        ));
        assert_eq!(
            ResultBudgetExceeded.to_string(),
            "The result was too large to return"
        );
    }
}
