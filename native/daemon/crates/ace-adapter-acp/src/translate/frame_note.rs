// SPDX-License-Identifier: Apache-2.0
//! Note frames (`translator.ts` note branch).

use crate::translate::data::{object, string};
use crate::translate::state::TranslationState;
use ace_json::{Map, Value};

/// Handle `note` frames. Always returns true (notes never fall through).
pub fn handle_note(
    state: &mut TranslationState,
    input_native_id: &mut Option<String>,
    data: &Value,
    data_map: &Map,
    facts: &mut Vec<Value>,
) -> bool {
    if data_map.get("event").and_then(Value::as_str) == Some("stop") {
        state.stopped = true;
    }
    if data_map.get("event").and_then(Value::as_str) == Some("process-start") {
        *input_native_id = None;
        state.reset_process();
        state.stopped = false;
        state.process_dead = false;
        let mut fact = Map::with_capacity(1);
        fact.insert(
            "type".to_owned(),
            Value::from("process.started".to_owned()),
        );
        facts.push(Value::Object(fact));
    }
    if data_map.get("event").and_then(Value::as_str) == Some("process-exit") {
        let deliberate = state.stopped
            || object(data_map.get("detail").unwrap_or(&Value::Null))
                .get("deliberate")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        let mut fact = Map::with_capacity(2);
        fact.insert(
            "type".to_owned(),
            Value::from("process.exited".to_owned()),
        );
        fact.insert("deliberate".to_owned(), Value::Bool(deliberate));
        facts.push(Value::Object(fact));
        state.reset_process();
        state.process_dead = true;
    }
    if data_map.get("event").and_then(Value::as_str) == Some("queue-changed")
        && let Some(count) = data_map.get("count")
        && (count.as_i64().is_some() || count.as_u64().is_some())
    {
        let mut fact = Map::with_capacity(2);
        fact.insert("type".to_owned(), Value::from("queue.changed".to_owned()));
        fact.insert("count".to_owned(), count.clone());
        facts.push(Value::Object(fact));
    }
    if data_map.get("event").and_then(Value::as_str) == Some("mcp-server-skipped") {
        let transport = string(data_map.get("transport").unwrap_or(&Value::Null)).to_uppercase();
        let name = string(data_map.get("name").unwrap_or(&Value::Null)).to_owned();
        let text = format!(
            "MCP server \"{name}\" was left out: this agent can't use {transport} MCP servers."
        );
        state.notice(facts, data, "recorder", Some(&text), None);
        return true;
    }
    if data_map.get("event").and_then(Value::as_str) == Some("input-sending") {
        *input_native_id =
            Some(string(data_map.get("nativeId").unwrap_or(&Value::Null)).to_owned());
        return true;
    }
    state.notice(facts, data, "recorder", None, None);
    true
}
