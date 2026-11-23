// SPDX-License-Identifier: Apache-2.0
//! Per-turn usage facts (`usage.ts`). The SDK's onDelta usage is authoritative
//! per turn; run totals never fold twice.

use super::json::{J, encode_units};

/// The largest integer JavaScript holds exactly.
const SAFE: f64 = 9_007_199_254_740_991.0;

fn tokens(value: &J) -> Option<i64> {
    match value {
        J::Num(raw) => {
            let float: f64 = raw.parse().ok()?;
            if !float.is_finite() || float.fract() != 0.0 || !(0.0..=SAFE).contains(&float) {
                return None;
            }
            Some(float as i64)
        }
        _ => None,
    }
}

/// The usage facts for one `turn-ended` delta, or nothing when invalid.
pub fn turn_usage(value: &J, agent: &[u16], counter_key: &[u16]) -> Vec<J> {
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
        facts.push(J::Obj(vec![
            (encode_units("type"), J::Str(encode_units("context.sample"))),
            (encode_units("agent"), J::Str(agent.to_vec())),
            (
                encode_units("usedTokens"),
                J::Num((occupied as i64).to_string()),
            ),
        ]));
    }
    let mut usage = vec![
        (encode_units("type"), J::Str(encode_units("usage"))),
        (encode_units("agent"), J::Str(agent.to_vec())),
        (encode_units("inputTokens"), J::Num(input.to_string())),
        (encode_units("outputTokens"), J::Num(output.to_string())),
    ];
    if let Some(cached) = cache_read {
        usage.push((
            encode_units("cachedInputTokens"),
            J::Num(cached.to_string()),
        ));
    }
    if let Some(written) = cache_write {
        usage.push((
            encode_units("cacheWriteTokens"),
            J::Num(written.to_string()),
        ));
    }
    if let Some(reasoning) = reasoning {
        usage.push((
            encode_units("reasoningTokens"),
            J::Num(reasoning.to_string()),
        ));
    }
    usage.push((
        encode_units("counterMode"),
        J::Str(encode_units("cumulative")),
    ));
    usage.push((encode_units("counterKey"), J::Str(counter_key.to_vec())));
    usage.push((encode_units("billingMode"), J::Str(encode_units("unknown"))));
    facts.push(J::Obj(usage));
    facts
}
