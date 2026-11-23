// SPDX-License-Identifier: Apache-2.0
//! Result usage accounting (the port of `result-usage.ts`).
//! Bounded duplicate window plus the native monotonic result sequence.

use serde_json::{Map, Value};
use std::collections::HashSet;

use super::json::{object, str_of};
use super::model_usage::{
    SessionCounts, model_session_fact, parse_model_usage, provider_session_fact,
};
use super::state::ClaudeState;
use super::token_counts::token_counts;

pub struct ResultUsage {
    seen: HashSet<String>,
    order: std::collections::VecDeque<String>,
    high_water: i64,
    epoch: String,
}

impl ResultUsage {
    pub fn new() -> Self {
        ResultUsage {
            seen: HashSet::new(),
            order: std::collections::VecDeque::new(),
            high_water: -1,
            epoch: "initial".to_owned(),
        }
    }

    pub fn reset(&mut self, data: &Value) {
        let obj = object(data);
        // string(new_conversation_id, string(uuid, epoch)): empty strings
        // are strings, so they win, exactly like the TypeScript.
        let epoch = match obj.get("new_conversation_id") {
            Some(Value::String(s)) => s.clone(),
            _ => match obj.get("uuid") {
                Some(Value::String(s)) => s.clone(),
                _ => self.epoch.clone(),
            },
        };
        self.epoch = epoch;
        self.high_water = -1;
    }

    pub fn accept(&mut self, data: &Value) -> bool {
        let obj = object(data);
        if let Some(Value::Number(n)) = obj.get("result_index")
            && let Some(index) = n.as_i64()
            && index >= 0
        {
            if index <= self.high_water {
                return false;
            }
            self.high_water = index;
        }
        let uuid = str_of(obj.get("uuid").unwrap_or(&Value::Null));
        if uuid.is_empty() {
            return true;
        }
        if self.seen.contains(&uuid) {
            return false;
        }
        if self.seen.len() >= 256
            && let Some(oldest) = self.order.pop_front()
        {
            self.seen.remove(&oldest);
        }
        self.seen.insert(uuid.clone());
        self.order.push_back(uuid);
        true
    }

    pub fn facts(&self, state: &mut ClaudeState, data: &Value) -> Vec<Value> {
        let obj = object(data);
        if obj.get("startup_failure_reason").is_some() {
            return Vec::new();
        }
        let usage = token_counts(obj.get("usage").unwrap_or(&Value::Null));
        let uuid = str_of(obj.get("uuid").unwrap_or(&Value::Null));
        let uuid = if uuid.is_empty() {
            state.key("result", &state.turn.to_string())
        } else {
            uuid
        };
        let mut facts = Vec::new();
        let models = parse_model_usage(obj.get("modelUsage").unwrap_or(&Value::Null));
        let context_window = match &models {
            Some(map) => state.model.as_ref().and_then(|m| {
                map.get(m).and_then(|entry| {
                    entry
                        .get("contextWindow")
                        .and_then(|v| v.as_i64())
                        .filter(|v| *v > 0)
                })
            }),
            None => None,
        };
        if let Some(u) = usage {
            let mut map = Map::with_capacity(10);
            map.insert("type".to_owned(), Value::String("usage".to_owned()));
            map.insert("agent".to_owned(), Value::String(state.root.clone()));
            map.insert(
                "inputTokens".to_owned(),
                Value::Number(u.input_tokens.into()),
            );
            map.insert(
                "outputTokens".to_owned(),
                Value::Number(u.output_tokens.into()),
            );
            map.insert(
                "cachedInputTokens".to_owned(),
                Value::Number(u.cached_input_tokens.into()),
            );
            map.insert(
                "cacheWriteTokens".to_owned(),
                Value::Number(u.cache_write_tokens.into()),
            );
            map.insert(
                "cacheWrite1hTokens".to_owned(),
                Value::Number(u.cache_write_1h_tokens.into()),
            );
            if let Some(r) = u.reasoning_tokens {
                map.insert("reasoningTokens".to_owned(), Value::Number(r.into()));
            }
            map.insert(
                "counterMode".to_owned(),
                Value::String("incremental".to_owned()),
            );
            map.insert(
                "counterKey".to_owned(),
                Value::String(format!("claude:result:{uuid}")),
            );
            map.insert("usageScope".to_owned(), Value::String("agent".to_owned()));
            if let Some(model) = &state.model {
                map.insert("model".to_owned(), Value::String(model.clone()));
            }
            if let Some(cw) = context_window {
                map.insert("contextWindow".to_owned(), Value::Number(cw.into()));
            }
            // Reorder to TypeScript insertion order: type, agent, the
            // tokenCounts spread (inputTokens, outputTokens, reasoningTokens?,
            // cachedInputTokens, cacheWriteTokens, cacheWrite1hTokens), then
            // counterMode, counterKey, usageScope, model?, contextWindow?
            let mut ordered = Map::with_capacity(map.len());
            for key in [
                "type",
                "agent",
                "inputTokens",
                "outputTokens",
                "reasoningTokens",
                "cachedInputTokens",
                "cacheWriteTokens",
                "cacheWrite1hTokens",
                "counterMode",
                "counterKey",
                "usageScope",
                "model",
                "contextWindow",
            ] {
                if let Some(v) = map.remove(key) {
                    ordered.insert(key.to_owned(), v);
                }
            }
            facts.push(Value::Object(ordered));
        }
        let counter_key = format!("claude:{}:{}", state.session, self.epoch);
        let mut input_tokens: i64 = 0;
        let mut output_tokens: i64 = 0;
        let mut cached: i64 = 0;
        let mut written: i64 = 0;
        if let Some(map) = &models {
            // BTreeMap iteration is sorted; the TypeScript iterates
            // Object.entries in insertion order. Fixture order is stable and
            // each entry emits its own fact, so per-entry facts match; only
            // the cumulative sums could differ under duplicate keys, which
            // cannot occur in one object.
            for (model, totals) in map {
                let input = totals
                    .get("inputTokens")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0)
                    .saturating_add(
                        totals
                            .get("cacheReadInputTokens")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0),
                    )
                    .saturating_add(
                        totals
                            .get("cacheCreationInputTokens")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0),
                    )
                    .min(9_007_199_254_740_991);
                input_tokens = input_tokens
                    .saturating_add(input)
                    .min(9_007_199_254_740_991);
                let out = totals
                    .get("outputTokens")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                output_tokens = output_tokens.saturating_add(out).min(9_007_199_254_740_991);
                cached = cached
                    .saturating_add(
                        totals
                            .get("cacheReadInputTokens")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0),
                    )
                    .min(9_007_199_254_740_991);
                written = written
                    .saturating_add(
                        totals
                            .get("cacheCreationInputTokens")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0),
                    )
                    .min(9_007_199_254_740_991);
                let cost = totals.get("costUSD").cloned().unwrap_or(Value::Null);
                let counts = SessionCounts {
                    input,
                    output: out,
                    cached: totals
                        .get("cacheReadInputTokens")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    written: totals
                        .get("cacheCreationInputTokens")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                };
                facts.push(model_session_fact(
                    &state.root,
                    model,
                    &counter_key,
                    &counts,
                    &cost,
                ));
            }
        }
        if let Some(Value::Number(n)) = obj.get("total_cost_usd")
            && let Some(cost) = n.as_f64()
            && cost >= 0.0
            && cost.is_finite()
        {
            facts.push(provider_session_fact(
                &state.root,
                &counter_key,
                input_tokens,
                output_tokens,
                cached,
                written,
                &Value::Number(n.clone()),
            ));
        }
        facts
    }
}

impl Default for ResultUsage {
    fn default() -> Self {
        Self::new()
    }
}
