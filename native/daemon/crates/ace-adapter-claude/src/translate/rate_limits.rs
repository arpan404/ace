// SPDX-License-Identifier: Apache-2.0
//! Native subscription rate limits (the port of `rate-limits.ts`).
//! No invented token limit or model entitlement.

use serde_json::{Map, Value};

use super::json::object;
use super::state::ClaudeState;

fn is_nonneg_number(value: &Value) -> bool {
    match value {
        Value::Number(n) => n
            .as_f64()
            .map(|v| v >= 0.0 && v.is_finite())
            .unwrap_or(false),
        _ => false,
    }
}

struct Observation {
    status: String,
    rate_limit_type: Option<String>,
    resets_at: Option<f64>,
    is_using_overage: bool,
    overage_status: Option<String>,
}

fn parse_observation(info: &Value) -> Option<Observation> {
    let obj = object(info);
    let status = obj.get("status").and_then(|v| v.as_str())?.to_owned();
    if status != "allowed" && status != "allowed_warning" && status != "rejected" {
        return None;
    }
    let rate_limit_type = match obj.get("rateLimitType") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            if s.chars().count() > 256 {
                return None;
            }
            Some(s.clone())
        }
        Some(_) => return None,
    };
    let resets_at = match obj.get("resetsAt") {
        None | Some(Value::Null) => None,
        Some(v) => {
            if !is_nonneg_number(v) {
                return None;
            }
            v.as_f64()
        }
    };
    if let Some(v) = obj.get("utilization")
        && !matches!(v, Value::Null)
        && !is_nonneg_number(v)
    {
        return None;
    }
    let is_using_overage = match obj.get("isUsingOverage") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return None,
    };
    let overage_status = match obj.get("overageStatus") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return None,
    };
    if let Some(v) = obj.get("overageResetsAt")
        && !matches!(v, Value::Null)
        && !is_nonneg_number(v)
    {
        return None;
    }
    Some(Observation {
        status,
        rate_limit_type,
        resets_at,
        is_using_overage,
        overage_status,
    })
}

pub fn rate_limit_facts(state: &mut ClaudeState, data: &Value) {
    let info = match object(data).get("rate_limit_info") {
        Some(v) => v.clone(),
        None => return,
    };
    let parsed = match parse_observation(&info) {
        Some(p) => p,
        None => return,
    };
    let bucket = parsed
        .rate_limit_type
        .unwrap_or_else(|| "unspecified".to_owned());
    if parsed.status == "rejected"
        && !parsed.is_using_overage
        && parsed.overage_status.as_deref() != Some("allowed")
    {
        if state.rate_blocks.len() >= 64 && !state.rate_blocks.contains(&bucket) {
            state.retry_on = Some("upstream".to_owned());
            state.emit(retry_fact(
                &state.root,
                "upstream",
                "Claude rate window capacity reached",
                None,
            ));
            return;
        }
        state.rate_blocks.insert(bucket);
        state.retry_on = Some("rate_limit".to_owned());
        let until = parsed.resets_at.map(|v| (v * 1000.0).round() as i64);
        state.emit(retry_fact(
            &state.root,
            "rate_limit",
            "Claude rate limit",
            until,
        ));
    } else {
        let was_blocked = state.rate_blocks.remove(&bucket);
        if was_blocked && state.rate_blocks.is_empty() {
            let root = state.root.clone();
            state.emit(limit_cleared(&root));
            if state.retry_on.as_deref() == Some("rate_limit") {
                state.retry_on = None;
            }
        }
    }
}

/// A native accepted run or successful result proves the previous block no
/// longer prevents work.
pub fn clear_rate_limit(state: &mut ClaudeState) {
    state.rate_blocks.clear();
    let root = state.root.clone();
    state.emit(limit_cleared(&root));
    if state.retry_on.as_deref() == Some("rate_limit") {
        state.retry_on = None;
    }
}

/// A response the model has started streaming proves a retried request got
/// through: the network or upstream wait is over.
pub fn clear_retry(state: &mut ClaudeState) {
    if state.retry_on.as_deref() != Some("network") && state.retry_on.as_deref() != Some("upstream")
    {
        return;
    }
    state.retry_on = None;
    let root = state.root.clone();
    state.emit(retry_cleared(&root));
}

fn retry_fact(root: &str, on: &str, message: &str, until: Option<i64>) -> Value {
    let mut map = Map::with_capacity(5);
    map.insert("type".to_owned(), Value::String("retry".to_owned()));
    map.insert("agent".to_owned(), Value::String(root.to_owned()));
    map.insert("on".to_owned(), Value::String(on.to_owned()));
    map.insert("message".to_owned(), Value::String(message.to_owned()));
    if let Some(at) = until {
        map.insert("until".to_owned(), Value::Number(at.into()));
    }
    Value::Object(map)
}

fn limit_cleared(root: &str) -> Value {
    let mut map = Map::with_capacity(2);
    map.insert("type".to_owned(), Value::String("limit.cleared".to_owned()));
    map.insert("agent".to_owned(), Value::String(root.to_owned()));
    Value::Object(map)
}

fn retry_cleared(root: &str) -> Value {
    let mut map = Map::with_capacity(2);
    map.insert("type".to_owned(), Value::String("retry.cleared".to_owned()));
    map.insert("agent".to_owned(), Value::String(root.to_owned()));
    Value::Object(map)
}
