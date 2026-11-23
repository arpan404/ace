// SPDX-License-Identifier: Apache-2.0
//! Child spawning and placeholders (`children.ts` spawn half).

use crate::translate::data::{object, string};
use crate::translate::state::TranslationState;
use ace_json::{Map, Value};

pub fn background_child(state: &mut TranslationState, tool_key: &str, facts: &mut Vec<Value>) {
    let (child_key, child_native_id, owner_key, title, raw) = match state.tools.get(tool_key) {
        Some(tool) => (
            tool.child_key.clone(),
            tool.child_native_id.clone(),
            tool.owner_key.clone(),
            string(tool.data.get("title").unwrap_or(&Value::Null)).to_owned(),
            tool.raw.clone(),
        ),
        None => return,
    };
    let Some(child_key) = child_key else {
        return;
    };
    let Some(child_native_id) = child_native_id else {
        return;
    };
    let child = state.agents.get(&child_native_id).cloned();
    let Some(mut child) = child else {
        return;
    };
    if child.parent.as_deref() != Some(owner_key.as_str()) || child.terminal {
        return;
    }
    // The tool's raw output must name a background spawn.
    let is_background = state
        .tools
        .get(tool_key)
        .and_then(|tool| tool.data.get("rawOutput"))
        .and_then(|output| object(output).get("isBackground"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !is_background {
        return;
    }
    child.background = true;
    let child_key_clone = child.key.clone();
    if let Some(stored) = state.agents.get_mut(&child_native_id) {
        stored.background = true;
    }
    state.background_tools.insert(tool_key.to_owned());
    state.start(&child_key_clone, facts, "spawn");
    let mut linked = Map::with_capacity(3);
    linked.insert("type".to_owned(), Value::from("agent.linked".to_owned()));
    linked.insert("agent".to_owned(), Value::from(child_key.clone()));
    linked.insert("background".to_owned(), Value::Bool(true));
    facts.push(Value::Object(linked));
    let has_task = state.tools.get(tool_key).and_then(|tool| tool.task.clone());
    if has_task.is_some() {
        return;
    }
    let task = state.key("background");
    if let Some(tool) = state.tools.get_mut(tool_key) {
        tool.task = Some(task.clone());
    }
    state
        .child_background_tools
        .entry(child_native_id.clone())
        .or_default()
        .insert(tool_key.to_owned());
    let mut started = Map::with_capacity(8);
    started.insert(
        "type".to_owned(),
        Value::from("background.started".to_owned()),
    );
    started.insert("agent".to_owned(), Value::from(owner_key));
    started.insert("task".to_owned(), Value::from(task));
    started.insert("kind".to_owned(), Value::from("subagent".to_owned()));
    started.insert("title".to_owned(), Value::from(title));
    let item_key = state
        .tools
        .get(tool_key)
        .map(|tool| tool.key.clone())
        .unwrap_or_default();
    started.insert("item".to_owned(), Value::from(item_key));
    started.insert("childAgent".to_owned(), Value::from(child_key));
    started.insert("stoppable".to_owned(), Value::Bool(false));
    started.insert("raw".to_owned(), Value::from(raw));
    facts.push(Value::Object(started));
}
pub fn placeholder_child(state: &mut TranslationState, tool_key: &str, facts: &mut Vec<Value>) {
    let has_child = state
        .tools
        .get(tool_key)
        .and_then(|tool| tool.child_key.clone());
    if has_child.is_none() {
        let id = state.key("placeholder");
        let child_key = state.agent_key(&id, facts);
        if let Some(child) = state.agents.get_mut(&id) {
            child.placeholder = true;
        }
        // The agent_key call creates a full child; adjust to placeholder.
        // Find by native id and patch.
        let title = state
            .tools
            .get(tool_key)
            .and_then(|tool| tool.data.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let owner_key = state
            .tools
            .get(tool_key)
            .map(|tool| tool.owner_key.clone())
            .unwrap_or_default();
        let tool_key_owned = tool_key.to_owned();
        if let Some(child) = state.agents.get_mut(&id) {
            child.placeholder = true;
            child.spawn = Some(tool_key_owned.clone());
        }
        if let Some(tool) = state.tools.get_mut(tool_key) {
            tool.child_key = Some(child_key.clone());
            tool.child_native_id = Some(id.clone());
        }
        state.child_tools.insert(id.clone(), tool_key.to_owned());
        // Patch the agent.seen the agent_key call emitted: it says full, but
        // TypeScript emits placeholder directly. Remove the last fact if it
        // was the full seen and replace with the placeholder seen.
        if let Some(Value::Object(last)) = facts.last()
            && last.get("type").and_then(Value::as_str) == Some("agent.seen")
            && last.get("agent").and_then(Value::as_str) == Some(child_key.as_str())
        {
            facts.pop();
        }
        let mut native = Map::with_capacity(1);
        native.insert(
            "provider".to_owned(),
            Value::from(state.quirks.provider().to_owned()),
        );
        let mut seen = Map::with_capacity(8);
        seen.insert("type".to_owned(), Value::from("agent.seen".to_owned()));
        seen.insert("agent".to_owned(), Value::from(child_key.clone()));
        seen.insert("parent".to_owned(), Value::from(owner_key.clone()));
        // spawnedBy
        let tool_item_key = state
            .tools
            .get(tool_key)
            .map(|tool| tool.key.clone())
            .unwrap_or_default();
        seen.insert("spawnedBy".to_owned(), Value::from(tool_item_key.clone()));
        seen.insert(
            "origin".to_owned(),
            Value::from("provider_subagent".to_owned()),
        );
        seen.insert(
            "fidelity".to_owned(),
            Value::from("placeholder".to_owned()),
        );
        seen.insert("native".to_owned(), Value::Object(native));
        seen.insert("cwd".to_owned(), Value::from(state.cwd.clone()));
        seen.insert("name".to_owned(), Value::from(title));
        facts.push(Value::Object(seen));
        let mut draft = Map::with_capacity(2);
        draft.insert("type".to_owned(), Value::from("tool_call".to_owned()));
        let mut call = Map::with_capacity(1);
        let mut detail = Map::with_capacity(2);
        detail.insert("kind".to_owned(), Value::from("agent.spawn".to_owned()));
        detail.insert("childAgent".to_owned(), Value::from(child_key.clone()));
        call.insert("detail".to_owned(), Value::Object(detail));
        draft.insert("call".to_owned(), Value::Object(call));
        let mut fact = Map::with_capacity(4);
        fact.insert("type".to_owned(), Value::from("item.upsert".to_owned()));
        fact.insert("agent".to_owned(), Value::from(owner_key));
        fact.insert("item".to_owned(), Value::from(tool_item_key));
        fact.insert("draft".to_owned(), Value::Object(draft));
        facts.push(Value::Object(fact));
        state.start(&child_key, facts, "spawn");
    }
    let status = state
        .tools
        .get(tool_key)
        .map(|tool| tool.status.clone())
        .unwrap_or_default();
    if ["succeeded", "failed", "declined", "cancelled"].contains(&status.as_str()) {
        let child_key = state
            .tools
            .get(tool_key)
            .and_then(|tool| tool.child_key.clone());
        if let Some(child_key) = child_key {
            let child_native = state
                .tools
                .get(tool_key)
                .and_then(|tool| tool.child_native_id.clone());
            let terminal = child_native
                .as_ref()
                .and_then(|id| state.agents.get(id))
                .is_some_and(|child| child.terminal);
            if !terminal {
                let outcome = match status.as_str() {
                    "succeeded" => "completed",
                    "cancelled" => "interrupted",
                    _ => "failed",
                };
                state.end(&child_key, facts, outcome, None);
            }
            if let Some(native_id) = child_native {
                if let Some(child) = state.agents.get_mut(&native_id) {
                    child.terminal = true;
                }
                state.disarm_cancel(&child_key);
                if state
                    .agents
                    .get(&native_id)
                    .is_some_and(|child| child.key == child_key)
                {
                    // Only placeholder children are removed from the index.
                    let is_placeholder = state
                        .agents
                        .get(&native_id)
                        .is_some_and(|child| child.placeholder);
                    if is_placeholder {
                        state.agents.shift_remove(&native_id);
                    }
                }
            } else {
                state.disarm_cancel(&child_key);
            }
        }
    }
}
