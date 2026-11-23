// SPDX-License-Identifier: Apache-2.0
//! Canonical enrichment (the port of `raw-facts.ts`).
//! Receipt diagnostics own raw data; canonical enrichment must preserve
//! prior raw.

use serde_json::Value;

use super::json::object;

/// Native evidence carried by canonical adapter facts.
pub fn fact_raw(fact: &Value) -> Vec<Value> {
    let obj = object(fact);
    let kind = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "item.upsert" => {
            let draft = object(obj.get("draft").unwrap_or(&Value::Null));
            let dtype = draft.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match dtype {
                "tool_call" => {
                    let call = object(draft.get("call").unwrap_or(&Value::Null));
                    match call.get("raw") {
                        Some(Value::Array(items)) => items.clone(),
                        _ => Vec::new(),
                    }
                }
                "message" | "notice" | "reasoning" => match draft.get("raw") {
                    Some(Value::Array(items)) => items.clone(),
                    _ => Vec::new(),
                },
                _ => Vec::new(),
            }
        }
        "interaction.opened" | "background.started" => match obj.get("raw") {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// Strip receipt-owned raw payloads so replay only enriches canonical facts.
pub fn canonical_only(fact: &Value) -> Value {
    let obj = object(fact);
    let kind = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "item.upsert" => {
            let draft = object(obj.get("draft").unwrap_or(&Value::Null));
            let dtype = draft.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match dtype {
                "tool_call" => {
                    let mut fact_map = obj.clone();
                    let mut draft_map = draft.clone();
                    let mut call_map = object(draft.get("call").unwrap_or(&Value::Null)).clone();
                    call_map.remove("raw");
                    draft_map.insert("call".to_owned(), Value::Object(call_map));
                    fact_map.insert("draft".to_owned(), Value::Object(draft_map));
                    Value::Object(fact_map)
                }
                "message" | "notice" | "reasoning" => {
                    let mut fact_map = obj.clone();
                    let mut draft_map = draft.clone();
                    draft_map.remove("raw");
                    fact_map.insert("draft".to_owned(), Value::Object(draft_map));
                    Value::Object(fact_map)
                }
                _ => fact.clone(),
            }
        }
        "interaction.opened" | "background.started" => {
            let mut fact_map = obj.clone();
            fact_map.remove("raw");
            Value::Object(fact_map)
        }
        _ => fact.clone(),
    }
}
