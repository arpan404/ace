// SPDX-License-Identifier: Apache-2.0
//! `boundedJson` (`@ace/provider-kit/ipc.ts:4`), the one copy: serialize a value under the SDK
//! byte, node, depth and array budgets. The TypeScript walks before it stringifies and refuses
//! as soon as an append passes the byte budget; this walks and writes in one pass, checking the
//! bytes after every piece, so a huge value is refused before the rest is built.
//!
//! The failure conditions are the TypeScript's: the emitted text's UTF-8 bytes pass the budget,
//! nodes (values plus an object's own keys, in visit order) pass 32,768, depth passes 64, an
//! array is longer than 32,768 minus the nodes counted so far, or a number is not finite.

use crate::Value;

/// The structural budgets (`NODES` and `DEPTH` in `ipc.ts`).
const NODES: usize = 32_768;
const DEPTH: usize = 64;

/// A value the budgets refuse; the TypeScript throws a `RangeError` or `TypeError`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BudgetError;

/// `boundedJson(value, maxBytes)`: `JSON.stringify(value)`, or the first budget it passes.
pub fn bounded_json(value: &Value, max_bytes: usize) -> Result<String, BudgetError> {
    let mut out = String::new();
    let mut nodes = 0;
    walk(value, 0, &mut nodes, &mut out, max_bytes)?;
    Ok(out)
}

fn walk(
    value: &Value,
    depth: usize,
    nodes: &mut usize,
    out: &mut String,
    max_bytes: usize,
) -> Result<(), BudgetError> {
    *nodes += 1;
    if *nodes > NODES || depth > DEPTH {
        return Err(BudgetError);
    }
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => {
            if !number.value().is_finite() {
                // `Number.isFinite` is false, so the TypeScript's walk refuses it.
                return Err(BudgetError);
            }
            crate::write_number(out, number.value());
        }
        Value::String(text) => crate::write_js_string(out, text),
        Value::Array(items) => {
            if items.len() > NODES - *nodes {
                return Err(BudgetError);
            }
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                walk(item, depth + 1, nodes, out, max_bytes)?;
            }
            out.push(']');
        }
        Value::Object(entries) => {
            out.push('{');
            for (index, (key, item)) in entries.iter().enumerate() {
                *nodes += 1;
                if *nodes > NODES {
                    return Err(BudgetError);
                }
                if index > 0 {
                    out.push(',');
                }
                crate::write_js_string(out, key);
                out.push(':');
                walk(item, depth + 1, nodes, out, max_bytes)?;
            }
            out.push('}');
        }
    }
    if out.len() > max_bytes {
        return Err(BudgetError);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Value;

    #[test]
    fn the_byte_budget_is_the_serialized_utf8_text() {
        // The quotes count: 2 + 100 bytes fit a budget of 102, one less does not.
        let value = Value::from("a".repeat(100));
        assert!(bounded_json(&value, 102).is_ok());
        assert_eq!(bounded_json(&value, 101), Err(BudgetError));
        // A multi-byte string's budget is its UTF-8 bytes, not its code units.
        let value = Value::from("é".repeat(50));
        assert!(bounded_json(&value, 102).is_ok());
        assert_eq!(bounded_json(&value, 101), Err(BudgetError));
        // A huge string is refused without building the rest of the value.
        let mut map = crate::Map::new();
        map.insert("big", Value::from("x".repeat(1_048_576)));
        map.insert("more", Value::from("y".repeat(1_048_576)));
        assert_eq!(bounded_json(&Value::Object(map), 64), Err(BudgetError));
    }

    #[test]
    fn the_node_budget_counts_values_and_an_objects_keys() {
        // Root plus 32,767 nulls is exactly 32,768 nodes.
        let fits = Value::Array(vec![Value::Null; NODES - 1].into());
        assert!(bounded_json(&fits, usize::MAX).is_ok());
        // One element over the array budget: 32,768 > 32,768 - 1.
        let over = Value::Array(vec![Value::Null; NODES].into());
        assert_eq!(bounded_json(&over, usize::MAX), Err(BudgetError));
        // An object's key is a node too: 16,384 keys and their values pass the node budget by
        // exactly one. If key counting were removed this object would fit instead.
        let mut map = crate::Map::new();
        for index in 0..NODES / 2 {
            map.insert(format!("k{index}"), Value::Null);
        }
        assert_eq!(
            bounded_json(&Value::Object(map), usize::MAX),
            Err(BudgetError)
        );
    }

    #[test]
    fn the_depth_budget_stops_after_64_levels() {
        let nest = |levels: usize| {
            let mut value = Value::Null;
            for _ in 0..levels {
                value = Value::Array(vec![value].into());
            }
            value
        };
        // The null sits at depth 64 and is allowed; at 65 it is not.
        assert!(bounded_json(&nest(64), usize::MAX).is_ok());
        assert_eq!(bounded_json(&nest(65), usize::MAX), Err(BudgetError));
    }

    #[test]
    fn an_array_may_not_be_longer_than_the_remaining_node_budget() {
        let mut map = crate::Map::new();
        map.insert("list", Value::Array(vec![Value::Null; 10].into()));
        // Root + key = 2 nodes; the array may hold 32,766 more.
        assert!(bounded_json(&Value::Object(map), usize::MAX).is_ok());
    }

    #[test]
    fn a_non_finite_number_is_refused_as_the_typescript_refuses_it() {
        // `JSON.parse("1e309")` is Infinity; `Number.isFinite` is false, so the walk refuses it.
        let value = crate::parse("1e309").unwrap();
        assert_eq!(bounded_json(&value, usize::MAX), Err(BudgetError));
    }
}
