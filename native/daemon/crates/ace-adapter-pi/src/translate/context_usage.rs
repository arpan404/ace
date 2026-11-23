// SPDX-License-Identifier: Apache-2.0
//! Context-usage sampling, mirroring `context-usage.ts`. The message is a
//! JSON string; it decodes through raw maps, never `Value` trees.

use std::collections::HashMap;

/// A validated Pi context sample.
#[derive(Debug, Clone)]
pub struct ContextSample {
    pub tokens: u64,
    pub context_window: u64,
    pub model: Option<String>,
}

/// Parse a Pi context-usage notification message.
pub fn pi_context_sample(message: Option<&str>) -> Option<ContextSample> {
    let text = message?;
    if text.encode_utf16().count() > 4096 {
        return None;
    }
    let map: HashMap<String, Box<serde_json::value::RawValue>> = serde_json::from_str(text).ok()?;
    let type_raw = map.get("type")?;
    let type_name: String = serde_json::from_str(type_raw.get()).ok()?;
    if type_name != "ace_context_usage" {
        return None;
    }
    let tokens = count_field(&map, "tokens")?;
    let context_window = count_field(&map, "contextWindow")?;
    if context_window == 0 {
        return None;
    }
    let model = match map.get("model") {
        Some(raw) => {
            let model: String = serde_json::from_str(raw.get()).ok()?;
            if model.is_empty() || model.encode_utf16().count() > 1024 {
                return None;
            }
            Some(model)
        }
        None => None,
    };
    Some(ContextSample {
        tokens,
        context_window,
        model,
    })
}

fn count_field(map: &HashMap<String, Box<serde_json::value::RawValue>>, key: &str) -> Option<u64> {
    let raw = map.get(key)?;
    // Numbers only: strings, bools and null read as missing, mirroring zod.
    let value: u64 = serde_json::from_str(raw.get()).ok()?;
    const MAX_SAFE: u64 = 9_007_199_254_740_991;
    if value <= MAX_SAFE { Some(value) } else { None }
}
