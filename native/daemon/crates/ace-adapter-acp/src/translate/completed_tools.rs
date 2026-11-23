// SPDX-License-Identifier: Apache-2.0
//! Published payloads belong to canonical storage (`completed-tools.ts`).

use crate::translate::state::{RETIRED_BYTES_LIMIT, RETIRED_COUNT_LIMIT, TranslationState};
use ace_json::{Map, Value};

pub fn retire_tool(state: &mut TranslationState, tool_key: &str) {
    let is_live = state.live_tools.contains(tool_key);
    let is_uncertain = state
        .tools
        .get(tool_key)
        .is_some_and(|tool| tool.uncertain_shell);
    if is_live || is_uncertain {
        return;
    }
    if let Some(tool) = state.tools.get_mut(tool_key) {
        tool.retired = true;
        tool.raw.clear();
        tool.initial_raw = None;
        tool.input_raw = None;
        tool.original_input = None;
    }
    if state.retired_tools.contains_key(tool_key) {
        return;
    }
    let child_terminal = match state.tools.get(tool_key) {
        Some(tool) => match tool.child_native_id.as_deref() {
            Some(child_id) => state
                .agents
                .get(child_id)
                .is_some_and(|child| !child.terminal),
            None => false,
        },
        None => return,
    };
    if child_terminal {
        return;
    }
    let bytes = {
        let tool = match state.tools.get(tool_key) {
            Some(tool) => tool,
            None => return,
        };
        let mut input_entries: Vec<Value> = Vec::new();
        if let Some(parts) = tool.input_parts.as_ref() {
            for (key, value) in parts.iter() {
                input_entries.push(Value::from(vec![Value::from(key.clone()), value.clone()]));
            }
        }
        let mut payload = Map::with_capacity(2);
        payload.insert("data".to_owned(), Value::Object(tool.data.clone()));
        payload.insert("input".to_owned(), Value::from(input_entries));
        ace_json::ser::to_string(&Value::Object(payload))
            .map(|text| text.len())
            .unwrap_or(0)
    };
    state.retired_tools.insert(tool_key.to_owned(), bytes);
    state.retired_bytes = state.retired_bytes.saturating_add(bytes);
    while state.retired_tools.len() > RETIRED_COUNT_LIMIT
        || state.retired_bytes > RETIRED_BYTES_LIMIT
    {
        let Some((oldest_key, cost)) = state.retired_tools.first().map(|(k, v)| (k.clone(), *v))
        else {
            break;
        };
        state.retired_tools.shift_remove(&oldest_key);
        state.retired_bytes = state.retired_bytes.saturating_sub(cost);
        let (owner_key, native_id, child_native_id, plan_owner) = match state.tools.get(&oldest_key)
        {
            Some(tool) => (
                tool.owner_key.clone(),
                tool.native_id.clone(),
                tool.child_native_id.clone(),
                tool.owner_key.clone(),
            ),
            None => continue,
        };
        if let Some(owned) = state.owned_tools.get_mut(&owner_key) {
            if owned.get(&native_id).is_some_and(|key| key == &oldest_key) {
                owned.shift_remove(&native_id);
            }
            if owned.is_empty() {
                state.owned_tools.shift_remove(&owner_key);
            }
        }
        if state
            .tools_by_native
            .get(&native_id)
            .is_some_and(|key| key == &oldest_key)
        {
            state.tools_by_native.shift_remove(&native_id);
        }
        state.tools.shift_remove(&oldest_key);
        // Clear a plan pointer that named the evicted tool.
        if owner_key == plan_owner {
            let clear_root = state.root.key == owner_key
                && state.root.plan_tool_key.as_deref() == Some(oldest_key.as_str());
            if clear_root {
                state.root.plan_tool_key = None;
            }
        }
        for agent in state.agents.values_mut() {
            if agent.plan_tool_key.as_deref() == Some(oldest_key.as_str()) {
                agent.plan_tool_key = None;
            }
        }
        if state.root.plan_tool_key.as_deref() == Some(oldest_key.as_str()) {
            state.root.plan_tool_key = None;
        }
        if let Some(child_id) = child_native_id
            && state
                .child_tools
                .get(&child_id)
                .is_some_and(|key| key == &oldest_key)
        {
            state.child_tools.shift_remove(&child_id);
        }
        state.background_tools.shift_remove(&oldest_key);
    }
}

pub fn renew_tool(state: &mut TranslationState, tool_key: &str) {
    if let Some(cost) = state.retired_tools.shift_remove(tool_key) {
        state.retired_bytes = state.retired_bytes.saturating_sub(cost);
    }
}
