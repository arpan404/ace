// SPDX-License-Identifier: Apache-2.0
//! Subagent token accounting (the port of `usage.ts`).
//! SDK blocks repeat message usage; refinements replace that message's
//! contribution.

use serde_json::{Map, Value};
use std::collections::HashMap;

use super::json::object;
use super::state::ClaudeState;
use super::token_counts::{TokenCounts, token_counts, zero_counts};

#[derive(Clone, Debug, Default)]
pub struct Accounting {
    pub messages: HashMap<String, TokenCounts>,
    pub total: TokenCounts,
}

pub type ChildUsage = HashMap<String, Accounting>;

/// Refine one message's contribution to its agent's cumulative usage.
pub fn child_usage(state: &mut ClaudeState, agent: &str, id: &str, message: &Value) {
    if object(message).get("usage").is_none() {
        return;
    }
    let sample = match object(message).get("usage") {
        Some(v) => v.clone(),
        None => return,
    };
    let next = match token_counts(&sample) {
        Some(n) => n,
        None => return,
    };
    let occupied = next.input_tokens.saturating_add(next.output_tokens);
    let input_tokens = object(&sample)
        .get("input_tokens")
        .and_then(|v| v.as_i64())
        .filter(|v| *v >= 0)
        .unwrap_or(-1);
    // Number.isSafeInteger(occupied): the sum must itself be a safe integer.
    let occupied_safe = occupied >= 0 && (occupied as f64) <= 9_007_199_254_740_991.0;
    let root = state.root.clone();
    if input_tokens >= 0 && occupied_safe {
        let mut map = Map::with_capacity(3);
        map.insert(
            "type".to_owned(),
            Value::String("context.sample".to_owned()),
        );
        map.insert("agent".to_owned(), Value::String(agent.to_owned()));
        map.insert("usedTokens".to_owned(), Value::Number(occupied.into()));
        if let Some(Value::String(model)) = object(message).get("model") {
            map.insert("model".to_owned(), Value::String(model.clone()));
        }
        state.emit(Value::Object(map));
    }
    if agent == root {
        return;
    }
    let at_capacity = match state.child_usage.get(agent) {
        None => state.child_usage.len() >= 256,
        Some(prior) => !prior.messages.contains_key(id) && prior.messages.len() >= 1024,
    };
    if at_capacity {
        if !state.child_usage_overflow {
            state.child_usage_overflow = true;
            let root_clone = state.root.clone();
            state.notice(
                message,
                "child-usage-capacity",
                &root_clone,
                "warning",
                Some("Claude child accounting capacity reached; additional message usage is omitted, native usage remains raw"),
            );
        }
        return;
    }
    let mut prior = state.child_usage.remove(agent).unwrap_or(Accounting {
        messages: HashMap::new(),
        total: zero_counts(),
    });
    let previous = prior.messages.get(id).cloned().unwrap_or_else(zero_counts);
    let mut next = next;
    next.input_tokens = next.input_tokens.max(previous.input_tokens);
    next.output_tokens = next.output_tokens.max(previous.output_tokens);
    next.cached_input_tokens = next.cached_input_tokens.max(previous.cached_input_tokens);
    next.cache_write_tokens = next.cache_write_tokens.max(previous.cache_write_tokens);
    next.cache_write_1h_tokens = next
        .cache_write_1h_tokens
        .max(previous.cache_write_1h_tokens);
    let totals = prior.total.clone();
    let mut total = zero_counts();
    total.input_tokens = totals
        .input_tokens
        .saturating_add(next.input_tokens.saturating_sub(previous.input_tokens))
        .min(9_007_199_254_740_991);
    total.output_tokens = totals
        .output_tokens
        .saturating_add(next.output_tokens.saturating_sub(previous.output_tokens))
        .min(9_007_199_254_740_991);
    total.cached_input_tokens = totals
        .cached_input_tokens
        .saturating_add(
            next.cached_input_tokens
                .saturating_sub(previous.cached_input_tokens),
        )
        .min(9_007_199_254_740_991);
    total.cache_write_tokens = totals
        .cache_write_tokens
        .saturating_add(
            next.cache_write_tokens
                .saturating_sub(previous.cache_write_tokens),
        )
        .min(9_007_199_254_740_991);
    total.cache_write_1h_tokens = totals
        .cache_write_1h_tokens
        .saturating_add(
            next.cache_write_1h_tokens
                .saturating_sub(previous.cache_write_1h_tokens),
        )
        .min(9_007_199_254_740_991);
    let prev_reason = previous.reasoning_tokens.unwrap_or(0);
    let next_reason = next.reasoning_tokens.unwrap_or(0);
    let total_reason = totals.reasoning_tokens.unwrap_or(0);
    if next.reasoning_tokens.is_some() || totals.reasoning_tokens.is_some() {
        let kept = next_reason.max(prev_reason);
        next.reasoning_tokens = Some(kept);
        total.reasoning_tokens = Some(
            total_reason
                .saturating_add(kept.saturating_sub(prev_reason))
                .min(9_007_199_254_740_991),
        );
    }
    let key = state.key("child-usage", agent);
    prior.messages.insert(id.to_owned(), next.clone());
    prior.total = total.clone();
    state.child_usage.insert(agent.to_owned(), prior);
    state.emit(usage_fact(agent, &key, &total));
}

fn usage_fact(agent: &str, key: &str, total: &TokenCounts) -> Value {
    let mut map = Map::with_capacity(10);
    map.insert("type".to_owned(), Value::String("usage".to_owned()));
    map.insert("agent".to_owned(), Value::String(agent.to_owned()));
    map.insert(
        "inputTokens".to_owned(),
        Value::Number(total.input_tokens.into()),
    );
    map.insert(
        "outputTokens".to_owned(),
        Value::Number(total.output_tokens.into()),
    );
    map.insert(
        "cachedInputTokens".to_owned(),
        Value::Number(total.cached_input_tokens.into()),
    );
    map.insert(
        "cacheWriteTokens".to_owned(),
        Value::Number(total.cache_write_tokens.into()),
    );
    map.insert(
        "cacheWrite1hTokens".to_owned(),
        Value::Number(total.cache_write_1h_tokens.into()),
    );
    if let Some(r) = total.reasoning_tokens {
        map.insert("reasoningTokens".to_owned(), Value::Number(r.into()));
    }
    map.insert(
        "counterMode".to_owned(),
        Value::String("cumulative".to_owned()),
    );
    map.insert("counterKey".to_owned(), Value::String(key.to_owned()));
    Value::Object(map)
}
