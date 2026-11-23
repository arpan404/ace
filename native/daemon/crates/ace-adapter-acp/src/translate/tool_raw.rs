// SPDX-License-Identifier: Apache-2.0
//! Tool raw collection (`tool-raw.ts`).

use crate::translate::data::{object, raw, string};
use serde_json::{Map, Value};

/// Original input, interpreted fields and latest change stay live.
pub fn retain_tool_raw(
    tool: &mut crate::translate::state::ToolState,
    payload: Value,
    update: &Value,
) {
    if tool.initial_raw.is_none() {
        tool.initial_raw = Some(payload.clone());
    }
    let update_map = object(update);
    if let Some(Value::Object(input)) = update_map.get("rawInput") {
        let parts = tool.input_parts.get_or_insert_with(indexmap::IndexMap::new);
        let mut changed = false;
        for (key, data) in input.iter() {
            let previous = parts.get(key);
            if previous.is_none_or(|old| old != data) {
                tool.completed_input = None;
                changed = true;
            }
            parts.insert(key.clone(), data.clone());
        }
        let _ = changed;
        if tool.original_input.is_none() && !input.is_empty() {
            tool.original_input = Some(input.clone());
        }
    }
    let needs_refresh = tool.input_raw.is_none()
        || update_map.contains_key("rawInput")
        || update_map.get("name").and_then(Value::as_str).is_some();
    if needs_refresh {
        let data_map = object(tool.data.get("rawInput").unwrap_or(&Value::Null));
        let fallback = tool.data.get("name").and_then(Value::as_str).unwrap_or("");
        let tool_name = string(data_map.get("_toolName").unwrap_or(&Value::Null));
        let name = if !tool_name.is_empty() {
            tool_name
        } else {
            fallback
        };
        let mut inner = Map::with_capacity(4);
        inner.insert(
            "initialFrame".to_owned(),
            tool.initial_raw.clone().unwrap_or(Value::Null),
        );
        inner.insert(
            "rawInput".to_owned(),
            tool.original_input
                .clone()
                .map(Value::Object)
                .unwrap_or(Value::Object(Map::new())),
        );
        inner.insert(
            "currentInput".to_owned(),
            tool.data
                .get("rawInput")
                .cloned()
                .unwrap_or(Value::Object(Map::new())),
        );
        if !name.is_empty() {
            inner.insert("nativeName".to_owned(), Value::String(name.to_owned()));
        }
        let name_opt = if name.is_empty() { None } else { Some(name) };
        tool.input_raw = Some(raw(&Value::Object(inner), "acp/tool-input", name_opt));
    }
    let mut raw_list = Vec::with_capacity(2);
    if let Some(input_raw) = tool.input_raw.clone() {
        raw_list.push(input_raw);
    }
    raw_list.push(payload);
    tool.raw = raw_list;
}

/// Terminal snapshots retain all partial input fields.
pub fn complete_tool_raw(
    tool: &mut crate::translate::state::ToolState,
) -> Option<Map<String, Value>> {
    let input_raw = tool.input_raw.clone()?;
    let completed = if let Some(done) = tool.completed_input.clone() {
        done
    } else {
        let parts = tool.input_parts.clone().unwrap_or_default();
        let assembled: Map<String, Value> = parts.into_iter().collect();
        tool.completed_input = Some(assembled.clone());
        assembled
    };
    let mut inner = object(&input_raw).clone();
    // The raw payload stores its data under `data`, not at the top.
    let data_value = inner
        .get("data")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut updated = data_value;
    updated.insert("rawInput".to_owned(), Value::Object(completed.clone()));
    inner.insert("data".to_owned(), Value::Object(updated));
    let completed_raw = Value::Object(inner);
    if !tool.raw.is_empty() {
        tool.raw[0] = completed_raw;
    }
    tool.finalized = true;
    Some(completed)
}
