// SPDX-License-Identifier: Apache-2.0
//! Context-usage sampling, mirroring `context-usage.ts`. The message is a
//! JSON string; it decodes through raw maps, never `Value` trees.


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
    let map = super::native::parse_object_text(text)?;
    let type_raw = map.get("type")?;
    let type_name: String = super::native::raw_as_str(type_raw)?;
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
            let model: String = super::native::raw_as_str(raw)?;
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

fn count_field(map: &super::native::Fields, key: &str) -> Option<u64> {
    let raw = map.get(key)?;
    // Numbers only: strings, bools and null read as missing, mirroring zod.
    let value: u64 = super::native::raw_as_u64(raw)?;
    const MAX_SAFE: u64 = 9_007_199_254_740_991;
    if value <= MAX_SAFE { Some(value) } else { None }
}
