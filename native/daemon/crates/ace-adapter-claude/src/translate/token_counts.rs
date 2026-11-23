// SPDX-License-Identifier: Apache-2.0
//! Native token counts (the port of `token-counts.ts`).
//! Lenient: any count that is not a non-negative safe integer fails the
//! whole sample, which the caller skips, never throws.

use serde_json::Value;

use super::json::{number, object};

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

#[derive(Clone, Debug, Default)]
pub struct TokenCounts {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_input_tokens: i64,
    pub cache_write_tokens: i64,
    pub cache_write_1h_tokens: i64,
    pub reasoning_tokens: Option<i64>,
}

fn count(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => {
            let v = n.as_i64()?;
            if v < 0 || (v as f64) > MAX_SAFE {
                return None;
            }
            // Reject non-integers encoded as floats.
            if n.as_f64().map(|f| f.fract() != 0.0).unwrap_or(false) {
                return None;
            }
            Some(v)
        }
        _ => None,
    }
}

fn opt_count(obj: &serde_json::Map<String, Value>, key: &str) -> Option<Option<i64>> {
    match obj.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(v) => count(v).map(Some),
    }
}

pub fn token_counts(data: &Value) -> Option<TokenCounts> {
    let obj = object(data);
    let input = match obj.get("input_tokens") {
        None => 0,
        Some(v) => count(v)?,
    };
    let output = match obj.get("output_tokens") {
        None => 0,
        Some(v) => count(v)?,
    };
    let details = match obj.get("output_tokens_details") {
        None | Some(Value::Null) => None,
        Some(v) => {
            if !matches!(v, Value::Object(_)) {
                return None;
            }
            Some(v)
        }
    };
    let thinking = match details {
        None => None,
        Some(d) => match object(d).get("thinking_tokens") {
            None | Some(Value::Null) => None,
            Some(v) => Some(count(v)?),
        },
    };
    let cached: i64 = opt_count(obj, "cache_read_input_tokens")?.unwrap_or_default();
    let created: i64 = opt_count(obj, "cache_creation_input_tokens")?.unwrap_or_default();
    let creation = match obj.get("cache_creation") {
        None | Some(Value::Null) => None,
        Some(v) => {
            if !matches!(v, Value::Object(_)) {
                return None;
            }
            Some(v)
        }
    };
    let ephemeral_1h = match creation {
        None => 0,
        Some(c) => match object(c).get("ephemeral_1h_input_tokens") {
            None | Some(Value::Null) => 0,
            Some(v) => count(v)?,
        },
    };
    if let Some(c) = creation {
        match object(c).get("ephemeral_5m_input_tokens") {
            None | Some(Value::Null) => {}
            Some(v) => {
                count(v)?;
            }
        }
    }
    let _ = number(data);
    let input_tokens = input.saturating_add(cached).saturating_add(created);
    let capped_1h = ephemeral_1h.min(created);
    Some(TokenCounts {
        input_tokens,
        output_tokens: output,
        cached_input_tokens: cached,
        cache_write_tokens: created,
        cache_write_1h_tokens: capped_1h,
        reasoning_tokens: thinking.map(|t| t.min(output)),
    })
}

pub fn zero_counts() -> TokenCounts {
    TokenCounts::default()
}
