// SPDX-License-Identifier: Apache-2.0
//! `boundedJson` (`@ace/provider-kit/ipc.ts:4`), the one copy: serialize a value under the SDK
//! byte, node, depth and array budgets. The TypeScript admits a value by walking it before
//! `JSON.stringify`; this walks the same budgets over [`Value`], whose shape already rules out
//! what the TypeScript's walk also refuses (non-JSON values, getters, cycles).
//!
//! The failure conditions are the TypeScript's: the emitted text's UTF-8 bytes pass the budget,
//! nodes (values plus an object's own keys, in visit order) pass 32,768, depth passes 64, or an
//! array is longer than 32,768 minus the nodes counted so far.

use crate::Value;

/// The structural budgets (`NODES` and `DEPTH` in `ipc.ts`).
const NODES: usize = 32_768;
const DEPTH: usize = 64;

/// A value the budgets refuse; the TypeScript throws a `RangeError`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BudgetError;

/// `boundedJson(value, maxBytes)`: `JSON.stringify(value)`, or the first budget it passes.
pub fn bounded_json(value: &Value, max_bytes: usize) -> Result<String, BudgetError> {
    let mut nodes = 0;
    walk(value, 0, &mut nodes)?;
    let text = crate::to_string(value);
    if text.len() > max_bytes {
        return Err(BudgetError);
    }
    Ok(text)
}

fn walk(value: &Value, depth: usize, nodes: &mut usize) -> Result<(), BudgetError> {
    *nodes += 1;
    if *nodes > NODES || depth > DEPTH {
        return Err(BudgetError);
    }
    match value {
        Value::Array(items) => {
            if items.len() > NODES - *nodes {
                return Err(BudgetError);
            }
            for item in items.iter() {
                walk(item, depth + 1, nodes)?;
            }
        }
        Value::Object(entries) => {
            for (_, item) in entries.iter() {
                *nodes += 1;
                if *nodes > NODES {
                    return Err(BudgetError);
                }
                walk(item, depth + 1, nodes)?;
            }
        }
        _ => {}
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
    }

    #[test]
    fn the_node_budget_counts_values_and_an_objects_keys() {
        // Root plus 32,767 nulls is exactly 32,768 nodes.
        let fits = Value::Array(vec![Value::Null; NODES - 1].into());
        assert!(bounded_json(&fits, usize::MAX).is_ok());
        // One element over the array budget: 32,768 > 32,768 - 1.
        let over = Value::Array(vec![Value::Null; NODES].into());
        assert_eq!(bounded_json(&over, usize::MAX), Err(BudgetError));
        // An object's key is a node too: one key plus its value is three.
        let mut map = crate::Map::new();
        map.insert("k", Value::Null);
        assert!(bounded_json(&Value::Object(map), usize::MAX).is_ok());
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
}
