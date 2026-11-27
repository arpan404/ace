// SPDX-License-Identifier: Apache-2.0
//! The fact-data guards of `fact-data.ts`.
//!
//! Provider facts cross into core as JSON text, so by the time they arrive
//! they can only hold plain objects, arrays, strings, finite numbers and
//! booleans: `is_fact_data` always holds, and the walk below documents that
//! rather than assuming it. Defaults added by schemas never remove unknown
//! provider fields; validation rejects facts that carry any.

use crate::json_io::Json;

/// Provider facts must survive JSON snapshots: plain data only. Facts arrive
/// as parsed JSON, which cannot hold functions, symbols, class instances,
/// cycles or non-finite numbers, so every fact passes; the iterative walk
/// pins that instead of trusting it.
pub fn is_fact_data(value: &Json) -> bool {
    let mut stack = vec![value];
    while let Some(current) = stack.pop() {
        match current {
            Json::Null | Json::Bool(_) | Json::String(_) => {}
            Json::Number(number) => {
                if number.as_f64().is_none_or(|float| !float.is_finite()) {
                    return false;
                }
            }
            Json::Array(items) => stack.extend(items.iter()),
            Json::Object(map) => stack.extend(map.values()),
        }
    }
    true
}
