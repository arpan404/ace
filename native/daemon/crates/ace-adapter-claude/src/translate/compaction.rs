// SPDX-License-Identifier: Apache-2.0
//! Context compaction (the port of `compaction.ts`).
//! Claude's compaction summary folds into the compaction's own item, never
//! a message of its own.

use ace_json::{Map, Value};

use super::json::{object, raw, str_of};
use super::state::ClaudeState;

fn optional_count(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => {
            let v = n.as_i64()?;
            if v < 0 || n.as_f64().map(|f| f.fract() != 0.0).unwrap_or(true) {
                None
            } else {
                Some(v)
            }
        }
        _ => None,
    }
}

fn compaction_key(state: &ClaudeState, uuid: &str, seq: i64) -> String {
    if uuid.is_empty() {
        state.key("compact", &seq.to_string())
    } else {
        format!("claude:compact:{uuid}")
    }
}

/// `system/compact_boundary`: the compaction's item, with token counts.
pub fn compact_boundary(state: &mut ClaudeState, data: &Value, seq: i64) {
    let uuid = str_of(object(data).get("uuid").unwrap_or(&Value::Null));
    let item = compaction_key(state, &uuid, seq);
    if state.compactions.contains_key(&item) {
        return;
    }
    let meta = object(object(data).get("compact_metadata").unwrap_or(&Value::Null));
    let before = meta.get("pre_tokens").and_then(optional_count);
    let after = meta.get("post_tokens").and_then(optional_count);
    let boundary = raw(data);
    state.compactions.insert(item.clone(), boundary.clone());
    state.compaction = Some(item.clone());
    let mut draft = Map::with_capacity(4);
    draft.insert("type".to_owned(), Value::from("compaction".to_owned()));
    draft.insert("complete".to_owned(), Value::Bool(true));
    if let Some(b) = before {
        draft.insert("tokensBefore".to_owned(), Value::Number(b.into()));
    }
    if let Some(a) = after {
        draft.insert("tokensAfter".to_owned(), Value::Number(a.into()));
    }
    draft.insert("raw".to_owned(), Value::from(vec![boundary]));
    // Rebuild in TypeScript order: type, complete, tokensBefore?,
    // tokensAfter?, raw.
    let mut ordered = Map::with_capacity(draft.len());
    for key in ["type", "complete", "tokensBefore", "tokensAfter", "raw"] {
        if let Some(v) = draft.remove(key) {
            ordered.insert(key.to_owned(), v);
        }
    }
    let root = state.root.clone();
    state.emit(upsert(&root, &item, Value::Object(ordered)));
}

fn only_text(data: &Value) -> Option<String> {
    let content = object(data)
        .get("message")
        .and_then(|m| object(m).get("content"));
    match content {
        Some(Value::String(s)) => {
            if s.is_empty() {
                None
            } else {
                Some(String::from(s.clone()))
            }
        }
        Some(Value::Array(blocks)) => {
            if blocks.is_empty() {
                return None;
            }
            let mut out = String::new();
            for block in blocks {
                let b = object(block);
                if b.get("type").and_then(|v| v.as_str()) != Some("text") {
                    return None;
                }
                out.push_str(b.get("text").and_then(|v| v.as_str()).unwrap_or(""));
            }
            if out.is_empty() { None } else { Some(out) }
        }
        _ => None,
    }
}

/// Folds a received user frame into the compaction it summarizes.
pub fn compact_summary(state: &mut ClaudeState, data: &Value, seq: i64) -> bool {
    let agent = state.agent_for(data);
    let root = state.root.clone();
    let is_user = str_of(object(data).get("type").unwrap_or(&Value::Null)) == "user";
    if agent != root || !is_user {
        if agent == root {
            state.compaction = None;
        }
        return false;
    }
    let uuid = str_of(object(data).get("uuid").unwrap_or(&Value::Null));
    if !uuid.is_empty() && state.compact_summaries.contains_key(&uuid) {
        return true;
    }
    let pending = state.compaction.clone();
    let is_compact_summary = object(data).get("isCompactSummary") == Some(&Value::Bool(true));
    let is_synthetic = object(data).get("isSynthetic") == Some(&Value::Bool(true));
    let eligible = is_compact_summary || (pending.is_some() && is_synthetic);
    let summary = if eligible { only_text(data) } else { None };
    state.compaction = None;
    let summary = match summary {
        Some(s) => s,
        None => return false,
    };
    let item = match pending {
        Some(p) => p,
        None => compaction_key(state, &uuid, seq),
    };
    if !uuid.is_empty() {
        state.compact_summaries.insert(uuid, item.clone());
    }
    let boundary = state.compactions.get(&item).cloned();
    let mut raw_list = Vec::new();
    if let Some(b) = boundary {
        raw_list.push(b);
    }
    raw_list.push(raw(data));
    let mut draft = Map::with_capacity(4);
    draft.insert("type".to_owned(), Value::from("compaction".to_owned()));
    draft.insert("complete".to_owned(), Value::Bool(true));
    draft.insert("summary".to_owned(), Value::from(summary));
    draft.insert("raw".to_owned(), Value::from(raw_list));
    state.emit(upsert(&root, &item, Value::Object(draft)));
    true
}

fn upsert(agent: &str, item: &str, draft: Value) -> Value {
    let mut map = Map::with_capacity(4);
    map.insert("type".to_owned(), Value::from("item.upsert".to_owned()));
    map.insert("agent".to_owned(), Value::from(agent.to_owned()));
    map.insert("item".to_owned(), Value::from(item.to_owned()));
    map.insert("draft".to_owned(), draft);
    Value::Object(map)
}
