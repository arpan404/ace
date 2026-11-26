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
    let type_raw = super::native::field(&map, "type")?;
    let type_name: String = super::native::raw_as_str(type_raw)?;
    if type_name != "ace_context_usage" {
        return None;
    }
    let tokens = count_field(&map, "tokens")?;
    let context_window = count_field(&map, "contextWindow")?;
    if context_window == 0 {
        return None;
    }
    let model = match super::native::field(&map, "model") {
        Some(raw) => {
            let model: String = super::native::raw_as_str(raw)?;
            if model.is_empty() || model.chars().count() > 1024 {
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
    let raw = super::native::field(map, key)?;
    // Numbers only: strings, bools and null read as missing, mirroring zod.
    let value: u64 = super::native::raw_as_u64(raw)?;
    const MAX_SAFE: u64 = 9_007_199_254_740_991;
    if value <= MAX_SAFE { Some(value) } else { None }
}

#[cfg(test)]
mod length_tests {
    use super::*;

    #[test]
    fn a_context_sample_accepts_1024_emoji_in_the_model_name() {
        for length in [1024, 1025] {
            let model = "😀".repeat(length);
            let sample = format!(
                r#"{{"type":"ace_context_usage","tokens":1,"contextWindow":2,"model":"{model}"}}"#
            );
            assert_eq!(pi_context_sample(Some(&sample)).is_some(), length == 1024);
        }
    }
}
