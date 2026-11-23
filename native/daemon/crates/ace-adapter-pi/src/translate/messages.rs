// SPDX-License-Identifier: Apache-2.0
//! Assistant and user message facts, mirroring `messages.ts`.

use super::native::{field, parse_array, parse_object, raw_as_str, str_field};
use ace_core::RawFact;
use serde::Serialize;
use serde_json::value::RawValue;
use std::collections::HashMap;

const MAX_SAFE: u64 = 9_007_199_254_740_991;

/// Outcome of a message, mirroring `MessageOutcome`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MessageOutcome {
    Completed,
    Failed,
    Interrupted,
}

/// Result of `message_facts`.
pub struct MessageResult {
    pub facts: Vec<RawFact>,
    pub outcome: Option<MessageOutcome>,
}

#[derive(Debug, Clone, Serialize)]
struct RawPayload<'a> {
    #[serde(rename = "type")]
    payload_type: String,
    data: &'a RawValue,
}

#[derive(Debug, Clone, Serialize)]
struct TextPart {
    #[serde(rename = "type")]
    part_type: String,
    text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
enum MessageDraft<'a> {
    #[serde(rename = "message")]
    Message {
        role: String,
        complete: bool,
        parts: Vec<TextPart>,
        raw: Vec<RawPayload<'a>>,
    },
    #[serde(rename = "reasoning")]
    Reasoning {
        complete: bool,
        text: String,
        raw: Vec<RawPayload<'a>>,
    },
}

#[derive(Debug, Clone, Serialize)]
struct ItemUpsert<'a> {
    #[serde(rename = "type")]
    fact_type: String,
    agent: String,
    item: String,
    draft: MessageDraft<'a>,
}

#[derive(Debug, Clone, Serialize)]
struct UsageFact {
    #[serde(rename = "type")]
    fact_type: String,
    agent: String,
    #[serde(rename = "inputTokens")]
    input_tokens: u64,
    #[serde(rename = "outputTokens")]
    output_tokens: u64,
    #[serde(rename = "cachedInputTokens")]
    cached_input_tokens: u64,
    #[serde(rename = "cacheWriteTokens")]
    cache_write_tokens: u64,
    #[serde(rename = "counterMode")]
    counter_mode: String,
    #[serde(rename = "counterKey", skip_serializing_if = "Option::is_none")]
    counter_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(rename = "billingMode", skip_serializing_if = "Option::is_none")]
    billing_mode: Option<String>,
    #[serde(rename = "costUsd", skip_serializing_if = "Option::is_none")]
    cost_usd: Option<f64>,
}

fn make_fact(fact_type: &str, json: String) -> Option<RawFact> {
    let data = serde_json::from_str::<Box<RawValue>>(&json).ok()?;
    Some(RawFact {
        fact_type: fact_type.to_owned(),
        data,
    })
}

fn raw_payload<'a>(data: &'a RawValue) -> RawPayload<'a> {
    let payload_type = super::native::raw_type_of(data, "message_end");
    RawPayload { payload_type, data }
}

fn serialize_upsert(upsert: &ItemUpsert<'_>) -> Option<String> {
    serde_json::to_string(upsert).ok()
}

/// Each admitted envelope is retained once; subsequent items retain only their block.
pub fn message_facts(agent: &str, prefix: &str, message: u64, data: &RawValue) -> MessageResult {
    let mut facts = Vec::new();
    let top = parse_object(data).unwrap_or_default();
    let message_raw = match field(&top, "message") {
        Some(raw) => raw,
        None => {
            return MessageResult {
                facts,
                outcome: None,
            };
        }
    };
    let parsed = parse_object(message_raw).unwrap_or_default();
    let role = str_field(&parsed, "role");
    if role == "assistant" {
        assistant_facts(agent, prefix, message, data, &parsed, &mut facts)
    } else if role == "user" {
        user_facts(agent, prefix, message, data, &parsed, &mut facts);
        MessageResult {
            facts,
            outcome: None,
        }
    } else {
        MessageResult {
            facts,
            outcome: None,
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn assistant_facts(
    agent: &str,
    prefix: &str,
    message: u64,
    frame_data: &RawValue,
    parsed: &HashMap<String, Box<RawValue>>,
    facts: &mut Vec<RawFact>,
) -> MessageResult {
    let mut retained = false;
    let mut order: u64 = 0;
    // Borrow the content list raw values without building `Value` trees.
    let content_items: Vec<Box<RawValue>> = match field(parsed, "content") {
        Some(raw) => parse_array(raw).unwrap_or_default(),
        None => Vec::new(),
    };
    for block_raw in &content_items {
        let block = parse_object(block_raw.as_ref()).unwrap_or_default();
        let block_type = str_field(&block, "type");
        if block_type != "text" && block_type != "thinking" {
            continue;
        }
        let index = order;
        order += 1;
        let raw_data: &RawValue = if retained {
            block_raw.as_ref()
        } else {
            frame_data
        };
        retained = true;
        let raw = vec![raw_payload(raw_data)];
        let item = format!("{prefix}:message:{message}:{index}");
        let draft = if block_type == "text" {
            MessageDraft::Message {
                role: "assistant".to_owned(),
                complete: true,
                parts: vec![TextPart {
                    part_type: "text".to_owned(),
                    text: str_field(&block, "text"),
                }],
                raw,
            }
        } else {
            MessageDraft::Reasoning {
                complete: true,
                text: str_field(&block, "thinking"),
                raw,
            }
        };
        let upsert = ItemUpsert {
            fact_type: "item.upsert".to_owned(),
            agent: agent.to_owned(),
            item,
            draft,
        };
        if let Some(json) = serialize_upsert(&upsert)
            && let Some(fact) = make_fact("item.upsert", json)
        {
            facts.push(fact);
        }
    }
    // Usage, mirroring `usageCounts` with cache defaults.
    push_usage(agent, parsed, facts);
    let reason = str_field(parsed, "stopReason");
    let outcome = match reason.as_str() {
        "stop" | "length" => Some(MessageOutcome::Completed),
        "error" => Some(MessageOutcome::Failed),
        "aborted" => Some(MessageOutcome::Interrupted),
        _ => None,
    };
    MessageResult {
        facts: std::mem::take(facts),
        outcome,
    }
}

fn push_usage(agent: &str, parsed: &HashMap<String, Box<RawValue>>, facts: &mut Vec<RawFact>) {
    let usage_raw = match field(parsed, "usage") {
        Some(raw) => raw,
        None => return,
    };
    let usage = parse_object(usage_raw).unwrap_or_default();
    let input = match count_value(&usage, "input") {
        Some(value) => value,
        None => return,
    };
    let output = match count_value(&usage, "output") {
        Some(value) => value,
        None => return,
    };
    let cache_read = match opt_count_value(&usage, "cacheRead") {
        Some(value) => value,
        None => return,
    };
    let cache_write = match opt_count_value(&usage, "cacheWrite") {
        Some(value) => value,
        None => return,
    };
    let summed = input.saturating_add(cache_read).saturating_add(cache_write);
    if summed > MAX_SAFE {
        return;
    }
    let provider = match field(parsed, "provider") {
        Some(raw) => raw_as_str(raw),
        None => None,
    };
    let model_name = match field(parsed, "model") {
        Some(raw) => raw_as_str(raw),
        None => None,
    };
    let model = match (provider.as_deref(), model_name.as_deref()) {
        (Some(provider), Some(model)) => Some(format!("{provider}/{model}")),
        _ => None,
    };
    let billing_mode = match provider.as_deref() {
        Some("openrouter") => Some("api".to_owned()),
        _ => None,
    };
    let timestamp_key = match field(parsed, "timestamp") {
        Some(raw) => timestamp_counter_key(raw),
        None => None,
    };
    let cost_usd = match field(&usage, "cost") {
        Some(cost_raw) => {
            let cost = parse_object(cost_raw).unwrap_or_default();
            match field(&cost, "total") {
                Some(total) => serde_json::from_str::<f64>(total.get()).ok(),
                None => None,
            }
        }
        None => {
            // Also support `cost` directly on usage? No: only `usage.cost.total`.
            // Fall back to missing, mirroring `obj(u.cost)`.
            None
        }
    };
    // The TypeScript also reads `obj(m.usage).cost` via `u.cost`; when `cost`
    // is missing, `cost.total` is missing, so no `costUsd`. When `cost` is not
    // an object, `obj` reads empty, so still none. The branch above covers it.
    // For `usage.cost` that is not an object, `parse_object` yields empty.
    let usage_fact = UsageFact {
        fact_type: "usage".to_owned(),
        agent: agent.to_owned(),
        input_tokens: summed,
        output_tokens: output,
        cached_input_tokens: cache_read,
        cache_write_tokens: cache_write,
        counter_mode: "incremental".to_owned(),
        counter_key: timestamp_key,
        model,
        billing_mode,
        cost_usd,
    };
    if let Ok(json) = serde_json::to_string(&usage_fact)
        && let Some(fact) = make_fact("usage", json)
    {
        facts.push(fact);
    }
}

fn count_value(map: &HashMap<String, Box<RawValue>>, key: &str) -> Option<u64> {
    let raw = field(map, key)?;
    let value: u64 = serde_json::from_str(raw.get()).ok()?;
    if value <= MAX_SAFE { Some(value) } else { None }
}

fn opt_count_value(map: &HashMap<String, Box<RawValue>>, key: &str) -> Option<u64> {
    match field(map, key) {
        Some(raw) => {
            let value: u64 = serde_json::from_str(raw.get()).ok()?;
            if value <= MAX_SAFE { Some(value) } else { None }
        }
        None => Some(0),
    }
}

fn timestamp_counter_key(raw: &RawValue) -> Option<String> {
    // `Number.isSafeInteger`: finite, integral, within ±MAX_SAFE.
    let value: f64 = serde_json::from_str(raw.get()).ok()?;
    if !value.is_finite() || value.fract() != 0.0 {
        return None;
    }
    if value.abs() > MAX_SAFE as f64 {
        return None;
    }
    let as_i64 = value as i64;
    Some(format!("pi:message:{as_i64}"))
}

fn user_facts(
    agent: &str,
    prefix: &str,
    message: u64,
    frame_data: &RawValue,
    parsed: &HashMap<String, Box<RawValue>>,
    facts: &mut Vec<RawFact>,
) {
    let parts = user_parts(parsed);
    let raw = vec![raw_payload(frame_data)];
    let draft = MessageDraft::Message {
        role: "user".to_owned(),
        complete: true,
        parts,
        raw,
    };
    let upsert = ItemUpsert {
        fact_type: "item.upsert".to_owned(),
        agent: agent.to_owned(),
        item: format!("{prefix}:user:{message}"),
        draft,
    };
    if let Some(json) = serialize_upsert(&upsert)
        && let Some(fact) = make_fact("item.upsert", json)
    {
        facts.push(fact);
    }
}

fn user_parts(parsed: &HashMap<String, Box<RawValue>>) -> Vec<TextPart> {
    let content_raw = match field(parsed, "content") {
        Some(raw) => raw,
        None => return Vec::new(),
    };
    // String content becomes one text part, mirroring the TypeScript.
    if let Some(text) = raw_as_str(content_raw) {
        // Distinguish a JSON string from other JSON: `raw_as_str` succeeds
        // only for strings, so this branch is the string case.
        return vec![TextPart {
            part_type: "text".to_owned(),
            text,
        }];
    }
    let items = parse_array(content_raw).unwrap_or_default();
    let mut parts = Vec::new();
    for item in &items {
        let block = parse_object(item.as_ref()).unwrap_or_default();
        if str_field(&block, "type") != "text" {
            continue;
        }
        parts.push(TextPart {
            part_type: "text".to_owned(),
            text: str_field(&block, "text"),
        });
    }
    parts
}
