// SPDX-License-Identifier: Apache-2.0
//! Child associations (`children.ts` update half).

use crate::translate::association::child_association;
use crate::translate::child_expiry::finish_child_tasks;
use crate::translate::child_spawn::background_child;
use crate::translate::completed_tools::retire_tool;
use crate::translate::data::{js_string, object, string};
use crate::translate::state::TranslationState;
use ace_json::{JsString, Map, Value};

pub fn child_update(
    state: &mut TranslationState,
    parent_key: &str,
    parent_native_id: &JsString,
    update: &Value,
    frame: &Value,
    facts: &mut Vec<Value>,
) -> bool {
    let Some(association) = child_association(update) else {
        return false;
    };
    if association.id == *parent_native_id {
        return false;
    }
    let child_key = state.agent_key(&association.id, facts);
    // Mark associated.
    if let Some(child) = state.agents.get_mut(&association.id) {
        child.associated = true;
    }
    let update_map = object(update);
    let meta = object(update_map.get("_meta").unwrap_or(&Value::Null));
    let cursor_meta = object(meta.get("cursor").unwrap_or(&Value::Null));
    let native_tool: JsString = js_string(cursor_meta.get("toolCallId").unwrap_or(&Value::Null))
        .cloned()
        .unwrap_or_default();
    let previous_tool = state.child_tools.get(&association.id).cloned();
    // Resolve the tool without holding borrows.
    let tool_key = if !native_tool.is_empty() {
        state.tool_mut(parent_key, parent_native_id, &native_tool)
    } else {
        previous_tool.as_ref().and_then(|key| {
            let owner_matches = state
                .tools
                .get(key)
                .is_some_and(|tool| tool.owner_key == *parent_key);
            if owner_matches {
                Some(key.clone())
            } else {
                None
            }
        })
    };
    if let Some(previous) = previous_tool.clone()
        && Some(previous.clone()) != tool_key
    {
        if let Some(tool) = state.tools.get_mut(&previous) {
            tool.child_key = None;
            tool.child_native_id = None;
        }
        if let Some(child) = state.agents.get_mut(&association.id) {
            child.spawn = None;
        }
        state.child_tools.shift_remove(&association.id);
    }
    // Pending spawn tracking.
    let pending_key = if !native_tool.is_empty() && tool_key.is_none() {
        Some(ace_json::ser::to_string(&(parent_key, native_tool.clone())).unwrap_or_default())
    } else {
        None
    };
    if let Some(child) = state.agents.get_mut(&association.id)
        && let Some(pending) = child.pending_spawn_key.clone()
    {
        state.pending_children.shift_remove(&pending);
        child.pending_spawn_key = None;
    }
    if let Some(pending) = pending_key.clone() {
        if let Some(child) = state.agents.get_mut(&association.id) {
            child.pending_spawn_key = Some(pending.clone());
        }
        state
            .pending_children
            .insert(pending, association.id.clone());
    }
    let input = object(
        state
            .tools
            .get(tool_key.as_deref().unwrap_or(""))
            .and_then(|tool| tool.data.get("rawInput"))
            .unwrap_or(&Value::Null),
    )
    .clone();
    // Patch parentage.
    if let Some(child) = state.agents.get_mut(&association.id) {
        child.parent = Some(parent_key.to_owned());
    }
    if let Some(tool_key) = tool_key.clone() {
        let child_key_clone = child_key.clone();
        if let Some(tool) = state.tools.get_mut(&tool_key) {
            tool.child_key = Some(child_key_clone.clone());
            tool.child_native_id = Some(association.id.clone());
        }
        if let Some(child) = state.agents.get_mut(&association.id) {
            child.spawn = state.tools.get(&tool_key).map(|tool| tool.key.clone());
        }
        state
            .child_tools
            .insert(association.id.clone(), tool_key.clone());
    }
    // agent.seen for the child.
    {
        let child_snapshot = state.agents.get(&association.id).cloned();
        let tool_snapshot = tool_key
            .as_ref()
            .and_then(|key| state.tools.get(key))
            .cloned();
        if let Some(child) = child_snapshot {
            let mut native = Map::with_capacity(2);
            native.insert(
                "provider".to_owned(),
                Value::from(state.quirks.provider().to_owned()),
            );
            native.insert("nativeId".to_owned(), Value::from(association.id.clone()));
            let mut seen = Map::with_capacity(10);
            seen.insert("type".to_owned(), Value::from("agent.seen".to_owned()));
            seen.insert("agent".to_owned(), Value::from(child.key.clone()));
            seen.insert("parent".to_owned(), Value::from(parent_key.to_owned()));
            if let Some(tool) = tool_snapshot.clone() {
                seen.insert("spawnedBy".to_owned(), Value::from(tool.key.clone()));
            }
            seen.insert(
                "origin".to_owned(),
                Value::from("provider_subagent".to_owned()),
            );
            seen.insert("fidelity".to_owned(), Value::from("full".to_owned()));
            seen.insert("native".to_owned(), Value::Object(native));
            seen.insert("cwd".to_owned(), Value::from(state.cwd.clone()));
            if let Some(Value::String(name)) = update_map.get("name") {
                seen.insert("role".to_owned(), Value::String(name.clone()));
            }
            // model from _meta.cursor.model
            let cursor = object(
                object(update_map.get("_meta").unwrap_or(&Value::Null))
                    .get("cursor")
                    .unwrap_or(&Value::Null),
            );
            if let Some(Value::String(model)) = cursor.get("model") {
                seen.insert("model".to_owned(), Value::String(model.clone()));
            }
            let description = js_string(input.get("description").unwrap_or(&Value::Null))
                .cloned()
                .unwrap_or_default();
            let title: JsString = js_string(update_map.get("title").unwrap_or(&Value::Null))
                .cloned()
                .unwrap_or_default();
            let name = if !description.is_empty() {
                description
            } else {
                title
            };
            if !name.is_empty() {
                seen.insert("name".to_owned(), Value::from(name));
            }
            facts.push(Value::Object(seen));
        }
    }
    if let Some(tool_key) = tool_key.clone() {
        let tool_snapshot = state.tools.get(&tool_key).cloned();
        if let Some(tool) = tool_snapshot {
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
            fact.insert("agent".to_owned(), Value::from(parent_key.to_owned()));
            fact.insert("item".to_owned(), Value::from(tool.key.clone()));
            fact.insert("draft".to_owned(), Value::Object(draft));
            facts.push(Value::Object(fact));
        }
        background_child(state, &tool_key, facts);
    }
    if association.update_type == "subagent_spawned" {
        state.start(&child_key, facts, "spawn");
    }
    let snapshot = object(update_map.get("state").unwrap_or(&Value::Null)).clone();
    if association.status == "running" {
        if let Some(child) = state.agents.get_mut(&association.id) {
            child.terminal = false;
        }
        state.start(&child_key, facts, "spawn");
    }
    if association.terminal {
        let child_terminal = state
            .agents
            .get(&association.id)
            .is_some_and(|child| !child.terminal);
        if child_terminal {
            let stop = string(snapshot.get("stopReason").unwrap_or(&Value::Null)).to_owned();
            let cancelled = association.status == "cancelled" || stop == "cancelled";
            let segment = state
                .agents
                .get(&association.id)
                .map(|child| child.segment.clone())
                .unwrap_or_default();
            let classified = state.quirks.classify_error(&segment).or_else(|| {
                if stop == "refusal" {
                    let mut error = Map::with_capacity(2);
                    error.insert("kind".to_owned(), Value::from("provider".to_owned()));
                    error.insert("code".to_owned(), Value::from("refusal".to_owned()));
                    error.insert(
                        "message".to_owned(),
                        Value::from("Subagent refused the prompt".to_owned()),
                    );
                    Some(Value::Object(error))
                } else {
                    None
                }
            });
            let failed = association.status == "failed" || classified.is_some();
            state.start(&child_key, facts, "spawn");
            let error = if failed {
                classified.or_else(|| {
                    let mut error = Map::with_capacity(2);
                    error.insert("kind".to_owned(), Value::from("provider".to_owned()));
                    error.insert(
                        "message".to_owned(),
                        Value::from(if segment.is_empty() {
                            "Subagent failed".to_owned()
                        } else {
                            segment.clone()
                        }),
                    );
                    Some(Value::Object(error))
                })
            } else {
                None
            };
            state.end(
                &child_key,
                facts,
                if cancelled {
                    "interrupted"
                } else if failed {
                    "failed"
                } else {
                    "completed"
                },
                error,
            );
            if let Some(child) = state.agents.get_mut(&association.id) {
                child.terminal = true;
            }
            if let Some(tool_key) = tool_key.clone() {
                state.background_tools.shift_remove(&tool_key);
            }
            state.disarm_cancel(&child_key);
            let parent_suspended = state
                .agent_by_key(parent_key)
                .is_some_and(|agent| agent.suspended);
            if parent_suspended {
                if let Some(parent) = state.agent_by_key_mut(parent_key) {
                    parent.suspended = false;
                }
                state.start(parent_key, facts, "subagent_result");
            }
            let status = if cancelled {
                "stopped"
            } else if failed {
                "failed"
            } else {
                "completed"
            };
            finish_child_tasks(state, &association.id, status, facts);
            if let Some(tool_key) = tool_key.clone() {
                retire_tool(state, &tool_key);
            }
        }
    }
    if association.status == "disconnected" {
        let mut fact = Map::with_capacity(2);
        fact.insert(
            "type".to_owned(),
            Value::from("agent.disconnected".to_owned()),
        );
        fact.insert("agent".to_owned(), Value::from(child_key.clone()));
        facts.push(Value::Object(fact));
        finish_child_tasks(state, &association.id, "unknown", facts);
        // Notice with the child as owner.
        let child_key_clone = child_key.clone();
        state.notice(
            facts,
            frame,
            "subagent_state_update",
            Some("Child disconnected; completion is unconfirmed"),
            Some(&child_key_clone),
        );
    }
    state.notice(
        facts,
        frame,
        &association.update_type,
        None,
        Some(parent_key),
    );
    true
}
