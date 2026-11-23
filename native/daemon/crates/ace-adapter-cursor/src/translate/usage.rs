// SPDX-License-Identifier: Apache-2.0
//! Per-turn usage facts (`usage.ts`). The SDK's onDelta usage is authoritative
//! per turn; run totals never fold twice.

use serde_json::{Value, json};

/// The largest integer JavaScript holds exactly.
const SAFE: f64 = 9_007_199_254_740_991.0;

fn tokens(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                return if int >= 0 { Some(int) } else { None };
            }
            if let Some(uint) = number.as_u64() {
                return if (uint as f64) <= SAFE {
                    Some(uint as i64)
                } else {
                    None
                };
            }
            None
        }
        _ => None,
    }
}

/// The usage facts for one `turn-ended` delta, or nothing when invalid.
pub fn turn_usage(value: &Value, agent: &str, counter_key: &str) -> Vec<Value> {
    let map = match value {
        Value::Object(map) => map,
        _ => return Vec::new(),
    };
    let Some(input) = map.get("inputTokens").and_then(tokens) else {
        return Vec::new();
    };
    let Some(output) = map.get("outputTokens").and_then(tokens) else {
        return Vec::new();
    };
    let cache_read = map.get("cacheReadTokens").map(tokens);
    let cache_write = map.get("cacheWriteTokens").map(tokens);
    let reasoning = map.get("reasoningTokens").map(tokens);
    if cache_read.is_some_and(|tokens| tokens.is_none())
        || cache_write.is_some_and(|tokens| tokens.is_none())
        || reasoning.is_some_and(|tokens| tokens.is_none())
    {
        return Vec::new();
    }
    let cache_read = cache_read.flatten();
    let cache_write = cache_write.flatten();
    let reasoning = reasoning.flatten();
    let occupied = input as i128
        + output as i128
        + cache_read.unwrap_or(0) as i128
        + cache_write.unwrap_or(0) as i128;
    let mut facts = Vec::new();
    if occupied <= SAFE as i128 {
        facts.push(
            json!({ "type": "context.sample", "agent": agent, "usedTokens": occupied as i64 }),
        );
    }
    let mut usage = json!({
        "type": "usage",
        "agent": agent,
        "inputTokens": input,
        "outputTokens": output,
        "counterMode": "cumulative",
        "counterKey": counter_key,
        "billingMode": "unknown",
    });
    if let Some(cached) = cache_read {
        usage["cachedInputTokens"] = Value::from(cached);
    }
    if let Some(written) = cache_write {
        usage["cacheWriteTokens"] = Value::from(written);
    }
    if let Some(reasoning) = reasoning {
        usage["reasoningTokens"] = Value::from(reasoning);
    }
    facts.push(usage);
    facts
}
