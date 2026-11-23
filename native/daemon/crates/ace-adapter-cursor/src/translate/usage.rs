// SPDX-License-Identifier: Apache-2.0
//! Per-turn usage facts (`usage.ts`). The SDK's onDelta usage is authoritative
//! per turn; run totals never fold twice.

use super::text::{JsString, Value};

/// The largest integer JavaScript holds exactly.
const SAFE: f64 = 9_007_199_254_740_991.0;

fn tokens(value: &Value) -> Option<i64> {
    match value {
        Value::Number(raw) => {
            let float: f64 = raw.value();
            if !float.is_finite() || float.fract() != 0.0 || !(0.0..=SAFE).contains(&float) {
                return None;
            }
            Some(float as i64)
        }
        _ => None,
    }
}

/// The usage facts for one `turn-ended` delta, or nothing when invalid.
pub fn turn_usage(value: &Value, agent: &JsString, counter_key: &JsString) -> Vec<Value> {
    let Some(input) = value.get("inputTokens").and_then(tokens) else {
        return Vec::new();
    };
    let Some(output) = value.get("outputTokens").and_then(tokens) else {
        return Vec::new();
    };
    let cache_read = value.get("cacheReadTokens").map(tokens);
    let cache_write = value.get("cacheWriteTokens").map(tokens);
    let reasoning = value.get("reasoningTokens").map(tokens);
    if cache_read == Some(None) || cache_write == Some(None) || reasoning == Some(None) {
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
        facts.push(Value::from(vec![
            (JsString::from("type"), Value::String(JsString::from("context.sample"))),
            (JsString::from("agent"), Value::String(agent.clone())),
            (
                JsString::from("usedTokens"),
                Value::from(occupied as i64),
            ),
        ]));
    }
    let mut usage = vec![
        (JsString::from("type"), Value::String(JsString::from("usage"))),
        (JsString::from("agent"), Value::String(agent.clone())),
        (JsString::from("inputTokens"), Value::from(input)),
        (JsString::from("outputTokens"), Value::from(output)),
    ];
    if let Some(cached) = cache_read {
        usage.push((
            JsString::from("cachedInputTokens"),
            Value::from(cached),
        ));
    }
    if let Some(written) = cache_write {
        usage.push((
            JsString::from("cacheWriteTokens"),
            Value::from(written),
        ));
    }
    if let Some(reasoning) = reasoning {
        usage.push((
            JsString::from("reasoningTokens"),
            Value::from(reasoning),
        ));
    }
    usage.push((
        JsString::from("counterMode"),
        Value::String(JsString::from("cumulative")),
    ));
    usage.push((JsString::from("counterKey"), Value::String(counter_key.clone())));
    usage.push((JsString::from("billingMode"), Value::String(JsString::from("unknown"))));
    facts.push(Value::from(usage));
    facts
}
