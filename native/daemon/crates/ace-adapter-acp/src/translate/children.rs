// SPDX-License-Identifier: Apache-2.0
//! Child sessions (`children.ts`).

use crate::translate::association::child_association;
use crate::translate::completed_tools::retire_tool;
use crate::translate::data::{object, string};
use crate::translate::state::TranslationState;
use serde_json::{Map, Value};

/// A surviving subagent becomes background work.
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
    linked.insert("type".to_owned(), Value::String("agent.linked".to_owned()));
    linked.insert("agent".to_owned(), Value::String(child_key.clone()));
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
        Value::String("background.started".to_owned()),
    );
    started.insert("agent".to_owned(), Value::String(owner_key));
    started.insert("task".to_owned(), Value::String(task));
    started.insert("kind".to_owned(), Value::String("subagent".to_owned()));
    started.insert("title".to_owned(), Value::String(title));
    let item_key = state
        .tools
        .get(tool_key)
        .map(|tool| tool.key.clone())
        .unwrap_or_default();
    started.insert("item".to_owned(), Value::String(item_key));
    started.insert("childAgent".to_owned(), Value::String(child_key));
    started.insert("stoppable".to_owned(), Value::Bool(false));
    started.insert("raw".to_owned(), Value::Array(raw));
    facts.push(Value::Object(started));
}

/// A subagent association update. Returns true when handled.
pub fn child_update(
    state: &mut TranslationState,
    parent_key: &str,
    parent_native_id: &str,
    update: &Value,
    frame: &Value,
    facts: &mut Vec<Value>,
) -> bool {
    let Some(association) = child_association(update) else {
        return false;
    };
    if association.id == parent_native_id {
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
    let native_tool = string(cursor_meta.get("toolCallId").unwrap_or(&Value::Null)).to_owned();
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
        Some(serde_json::to_string(&(parent_key, native_tool.clone())).unwrap_or_default())
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
                Value::String(state.quirks.provider().to_owned()),
            );
            native.insert("nativeId".to_owned(), Value::String(association.id.clone()));
            let mut seen = Map::with_capacity(10);
            seen.insert("type".to_owned(), Value::String("agent.seen".to_owned()));
            seen.insert("agent".to_owned(), Value::String(child.key.clone()));
            seen.insert("parent".to_owned(), Value::String(parent_key.to_owned()));
            if let Some(tool) = tool_snapshot.clone() {
                seen.insert("spawnedBy".to_owned(), Value::String(tool.key.clone()));
            }
            seen.insert(
                "origin".to_owned(),
                Value::String("provider_subagent".to_owned()),
            );
            seen.insert("fidelity".to_owned(), Value::String("full".to_owned()));
            seen.insert("native".to_owned(), Value::Object(native));
            seen.insert("cwd".to_owned(), Value::String(state.cwd.clone()));
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
            let description = string(input.get("description").unwrap_or(&Value::Null));
            let title = string(update_map.get("title").unwrap_or(&Value::Null));
            let name = if !description.is_empty() {
                description.to_owned()
            } else {
                title.to_owned()
            };
            if !name.is_empty() {
                seen.insert("name".to_owned(), Value::String(name));
            }
            facts.push(Value::Object(seen));
        }
    }
    if let Some(tool_key) = tool_key.clone() {
        let tool_snapshot = state.tools.get(&tool_key).cloned();
        if let Some(tool) = tool_snapshot {
            let mut draft = Map::with_capacity(2);
            draft.insert("type".to_owned(), Value::String("tool_call".to_owned()));
            let mut call = Map::with_capacity(1);
            let mut detail = Map::with_capacity(2);
            detail.insert("kind".to_owned(), Value::String("agent.spawn".to_owned()));
            detail.insert("childAgent".to_owned(), Value::String(child_key.clone()));
            call.insert("detail".to_owned(), Value::Object(detail));
            draft.insert("call".to_owned(), Value::Object(call));
            let mut fact = Map::with_capacity(4);
            fact.insert("type".to_owned(), Value::String("item.upsert".to_owned()));
            fact.insert("agent".to_owned(), Value::String(parent_key.to_owned()));
            fact.insert("item".to_owned(), Value::String(tool.key.clone()));
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
                    error.insert("kind".to_owned(), Value::String("provider".to_owned()));
                    error.insert("code".to_owned(), Value::String("refusal".to_owned()));
                    error.insert(
                        "message".to_owned(),
                        Value::String("Subagent refused the prompt".to_owned()),
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
                    error.insert("kind".to_owned(), Value::String("provider".to_owned()));
                    error.insert(
                        "message".to_owned(),
                        Value::String(if segment.is_empty() {
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
            let parent_suspended = if parent_key == state.root.key {
                state.root.suspended
            } else {
                state
                    .agents
                    .values()
                    .find(|agent| agent.key == *parent_key)
                    .is_some_and(|agent| agent.suspended)
            };
            if parent_suspended {
                if parent_key == state.root.key {
                    state.root.suspended = false;
                } else if let Some(parent) = state
                    .agents
                    .values_mut()
                    .find(|agent| agent.key == *parent_key)
                {
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
            Value::String("agent.disconnected".to_owned()),
        );
        fact.insert("agent".to_owned(), Value::String(child_key.clone()));
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

/// A placeholder for an Antigravity subagent with no native session.
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
            Value::String(state.quirks.provider().to_owned()),
        );
        let mut seen = Map::with_capacity(8);
        seen.insert("type".to_owned(), Value::String("agent.seen".to_owned()));
        seen.insert("agent".to_owned(), Value::String(child_key.clone()));
        seen.insert("parent".to_owned(), Value::String(owner_key.clone()));
        // spawnedBy
        let tool_item_key = state
            .tools
            .get(tool_key)
            .map(|tool| tool.key.clone())
            .unwrap_or_default();
        seen.insert("spawnedBy".to_owned(), Value::String(tool_item_key.clone()));
        seen.insert(
            "origin".to_owned(),
            Value::String("provider_subagent".to_owned()),
        );
        seen.insert(
            "fidelity".to_owned(),
            Value::String("placeholder".to_owned()),
        );
        seen.insert("native".to_owned(), Value::Object(native));
        seen.insert("cwd".to_owned(), Value::String(state.cwd.clone()));
        seen.insert("name".to_owned(), Value::String(title));
        facts.push(Value::Object(seen));
        let mut draft = Map::with_capacity(2);
        draft.insert("type".to_owned(), Value::String("tool_call".to_owned()));
        let mut call = Map::with_capacity(1);
        let mut detail = Map::with_capacity(2);
        detail.insert("kind".to_owned(), Value::String("agent.spawn".to_owned()));
        detail.insert("childAgent".to_owned(), Value::String(child_key.clone()));
        call.insert("detail".to_owned(), Value::Object(detail));
        draft.insert("call".to_owned(), Value::Object(call));
        let mut fact = Map::with_capacity(4);
        fact.insert("type".to_owned(), Value::String("item.upsert".to_owned()));
        fact.insert("agent".to_owned(), Value::String(owner_key));
        fact.insert("item".to_owned(), Value::String(tool_item_key));
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

/// Expire children whose cancellation deadline passed.
pub fn expire_children(state: &mut TranslationState, now: i64) -> Vec<Value> {
    let mut facts = Vec::new();
    let cancelling: Vec<String> = state.cancelling.iter().cloned().collect();
    for agent_key in cancelling {
        let (terminal, cancel_at, native_id) = if agent_key == state.root.key {
            (
                state.root.terminal,
                state.root.cancel_at,
                state.root.native_id.clone(),
            )
        } else {
            match state.agents.values().find(|agent| agent.key == *agent_key) {
                Some(agent) => (agent.terminal, agent.cancel_at, agent.native_id.clone()),
                None => {
                    state.disarm_cancel(&agent_key);
                    continue;
                }
            }
        };
        if terminal {
            state.disarm_cancel(&agent_key);
            continue;
        }
        if cancel_at.is_none_or(|at| now < at) {
            continue;
        }
        state.start(&agent_key, &mut facts, "spawn");
        state.end(&agent_key, &mut facts, "interrupted", None);
        if agent_key == state.root.key {
            state.root.terminal = true;
        } else if let Some(agent) = state
            .agents
            .values_mut()
            .find(|agent| agent.key == *agent_key)
        {
            agent.terminal = true;
        }
        state.disarm_cancel(&agent_key);
        finish_child_tasks(state, &native_id, "unknown", &mut facts);
        let mut detail = Map::with_capacity(2);
        detail.insert("deadline".to_owned(), Value::from(now));
        detail.insert("nativeId".to_owned(), Value::String(native_id.clone()));
        state.notice(
            &mut facts,
            &Value::Object(detail),
            "ace/cancel-timeout",
            Some("No child cancellation update within 12 seconds"),
            Some(&agent_key),
        );
    }
    facts
}

fn finish_child_tasks(
    state: &mut TranslationState,
    child_native_id: &str,
    status: &str,
    facts: &mut Vec<Value>,
) {
    let Some(tools) = state.child_background_tools.get(child_native_id).cloned() else {
        return;
    };
    for tool_key in tools {
        if let Some(task) = state
            .tools
            .get(&tool_key)
            .and_then(|tool| tool.task.clone())
        {
            let mut fact = Map::with_capacity(3);
            fact.insert(
                "type".to_owned(),
                Value::String("background.ended".to_owned()),
            );
            fact.insert("task".to_owned(), Value::String(task));
            fact.insert("status".to_owned(), Value::String(status.to_owned()));
            facts.push(Value::Object(fact));
        }
        state.background_tools.shift_remove(&tool_key);
        if status != "unknown" {
            let owner_key = state
                .tools
                .get(&tool_key)
                .map(|tool| tool.owner_key.clone());
            if let Some(owner_key) = owner_key {
                let suspended = if owner_key == state.root.key {
                    state.root.suspended
                } else {
                    state
                        .agents
                        .values()
                        .find(|agent| agent.key == *owner_key)
                        .is_some_and(|agent| agent.suspended)
                };
                if suspended {
                    if owner_key == state.root.key {
                        state.root.suspended = false;
                    } else if let Some(owner) = state
                        .agents
                        .values_mut()
                        .find(|agent| agent.key == *owner_key)
                    {
                        owner.suspended = false;
                    }
                    state.start(&owner_key, facts, "subagent_result");
                }
            }
        }
    }
    if status != "unknown" {
        state.child_background_tools.shift_remove(child_native_id);
    }
}
