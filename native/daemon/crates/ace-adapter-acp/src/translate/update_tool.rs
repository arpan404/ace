// SPDX-License-Identifier: Apache-2.0
//! Tool call updates (part of `translator.ts` `update`).

use crate::translate::completed_tools::{renew_tool, retire_tool};
use crate::translate::data::{object, raw, string};
use crate::translate::prompt_hold::sync_prompt_hold;
use crate::translate::shell_output::ShellOutput;
use crate::translate::state::TranslationState;
use crate::translate::tool_final::{current_tool_detail, finalize_tool};
use crate::translate::tool_raw::retain_tool_raw;
use crate::translate::tool_text::{merge_tool_data, tool_error};
use crate::translate::tools::{tool_detail, tool_status};
use crate::translate::update::error_key;
use ace_json::{Map, Value};

/// Handle `tool_call` and `tool_call_update`. Returns true when handled.
pub fn handle_tool_call(
    state: &mut TranslationState,
    shell_output: &mut ShellOutput,
    agent_key: &str,
    agent_native_id: &str,
    update: &Value,
    frame: &Value,
    facts: &mut Vec<Value>,
) -> bool {
    let update_map = object(update);
    let id = string(update_map.get("toolCallId").unwrap_or(&Value::Null)).to_owned();
    if id.is_empty() {
        return false;
    }
    // Snapshot prior state.
    let existing_key = state.tool_mut(agent_key, agent_native_id, &id);
    let (prior_status, prior_title, prior_name, prior_kind, prior_output, retired) =
        match existing_key.as_ref().and_then(|key| state.tools.get(key)) {
            Some(tool) => (
                Some(tool.status.clone()),
                tool.data.get("title").cloned(),
                tool.data.get("name").cloned(),
                tool.data.get("kind").cloned(),
                object(tool.data.get("rawOutput").unwrap_or(&Value::Null)).clone(),
                tool.retired,
            ),
            None => (None, None, None, None, Map::new(), false),
        };
    let retained_raw = retired && !update_map.contains_key("rawInput");
    // Create when missing.
    let tool_key = if let Some(key) = existing_key {
        key
    } else {
        let new_key = state.key("tool");
        let owner_native = agent_native_id.to_owned();
        let tool = crate::translate::state::ToolState {
            native_id: id.clone(),
            key: new_key.clone(),
            owner_key: agent_key.to_owned(),
            owner_native_id: owner_native,
            data: Map::new(),
            status: "pending".to_owned(),
            raw: Vec::new(),
            input_raw: None,
            initial_raw: None,
            original_input: None,
            input_parts: None,
            completed_input: None,
            finalized: false,
            retired: false,
            uncertain_shell: false,
            child_native_id: None,
            child_key: None,
            task: None,
            carried: false,
            hold_task: None,
            declined: false,
            published_error: None,
        };
        state.tools.insert(new_key.clone(), tool);
        state.register_tool(agent_key, &id, &new_key);
        new_key
    };
    // Pending child linkage.
    let pending_lookup = ace_json::ser::to_string(&(agent_key, id.clone())).unwrap_or_default();
    let pending_child = state.pending_children.get(&pending_lookup).cloned();
    if let Some(child_native) = pending_child.clone() {
        let child_key = state
            .agents
            .get(&child_native)
            .map(|agent| agent.key.clone())
            .unwrap_or_default();
        if let Some(tool) = state.tools.get_mut(&tool_key) {
            tool.child_key = Some(child_key.clone());
            tool.child_native_id = Some(child_native.clone());
        }
        if let Some(child) = state.agents.get_mut(&child_native) {
            child.spawn = Some(
                state
                    .tools
                    .get(&tool_key)
                    .map(|tool| tool.key.clone())
                    .unwrap_or_default(),
            );
            child.pending_spawn_key = None;
        }
        state.child_tools.insert(child_native, tool_key.clone());
        state.pending_children.shift_remove(&pending_lookup);
        let mut linked = Map::with_capacity(4);
        linked.insert("type".to_owned(), Value::from("agent.linked".to_owned()));
        linked.insert("agent".to_owned(), Value::from(child_key));
        linked.insert("parent".to_owned(), Value::from(agent_key.to_owned()));
        let item_key = state
            .tools
            .get(&tool_key)
            .map(|tool| tool.key.clone())
            .unwrap_or_default();
        linked.insert("spawnedBy".to_owned(), Value::from(item_key));
        facts.push(Value::Object(linked));
    }
    // Merge and status.
    if let Some(tool) = state.tools.get_mut(&tool_key) {
        let mut owned = tool.clone();
        merge_tool_data(&mut owned.data, update);
        let declined = owned.declined;
        owned.status = if declined {
            "declined".to_owned()
        } else {
            tool_status(update, &owned.status)
        };
        *tool = owned;
    }
    // Raw retention needs the tool's current name.
    {
        let (raw_name, update_clone) = {
            let tool = state.tools.get(&tool_key).cloned();
            match tool {
                Some(tool) => {
                    let raw_input = object(tool.data.get("rawInput").unwrap_or(&Value::Null));
                    let tool_name = string(raw_input.get("_toolName").unwrap_or(&Value::Null));
                    let fallback = string(tool.data.get("name").unwrap_or(&Value::Null));
                    let name = if !tool_name.is_empty() {
                        tool_name.to_owned()
                    } else {
                        fallback.to_owned()
                    };
                    (name, update.clone())
                }
                None => (String::new(), update.clone()),
            }
        };
        let payload = raw(
            frame,
            "session/update",
            Some(&raw_name)
                .filter(|name| !name.is_empty())
                .map(String::as_str),
        );
        if let Some(tool) = state.tools.get_mut(&tool_key) {
            let mut owned = tool.clone();
            retain_tool_raw(&mut owned, payload, &update_clone);
            *tool = owned;
        }
    }
    let live = {
        let is_live = state.tools.get(&tool_key).is_some_and(|tool| {
            ["pending", "running", "awaiting_approval"].contains(&tool.status.as_str())
        });
        if is_live {
            state.live_tools.insert(tool_key.clone());
        } else {
            state.live_tools.shift_remove(&tool_key);
        }
        is_live
    };
    if live {
        renew_tool(state, &tool_key);
    }
    sync_prompt_hold(state, &tool_key, live, facts);
    // Definition changed?
    let definition_changed = {
        let tool = state.tools.get(&tool_key).cloned();
        match tool {
            Some(tool) => {
                let mut changed =
                    update_map.contains_key("content") || update_map.contains_key("_meta");
                if !changed {
                    for key in ["title", "name", "kind"] {
                        if let Some(Value::String(next)) = update_map.get(key) {
                            let prior = match key {
                                "title" => prior_title.as_ref(),
                                "name" => prior_name.as_ref(),
                                "kind" => prior_kind.as_ref(),
                                _ => None,
                            };
                            let prior_text = prior.and_then(Value::as_str).unwrap_or("");
                            if next != prior_text {
                                changed = true;
                                break;
                            }
                        }
                    }
                }
                if !changed && tool.finalized && tool.completed_input.is_none() {
                    changed = true;
                }
                if !changed {
                    let raw_output = object(update_map.get("rawOutput").unwrap_or(&Value::Null));
                    for (key, value) in raw_output.iter() {
                        if ["exitCode", "totalFiles", "isBackground"].contains(&key.as_str())
                            && Some(value) != prior_output.get(key)
                        {
                            changed = true;
                            break;
                        }
                    }
                }
                changed
            }
            None => false,
        }
    };
    if definition_changed {
        renew_tool(state, &tool_key);
    }
    let error = {
        let status = state
            .tools
            .get(&tool_key)
            .map(|tool| tool.status.clone())
            .unwrap_or_default();
        if status == "failed" {
            tool_error(update)
        } else {
            None
        }
    };
    let error_digest = error.as_deref().map(error_key);
    let new_error = update_map
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| status == "failed")
        && error_digest.is_some()
        && state
            .tools
            .get(&tool_key)
            .and_then(|tool| tool.published_error.clone())
            .as_deref()
            != error_digest.as_deref();
    // Early return for finalized, unchanged, non-error updates.
    {
        let tool = state.tools.get(&tool_key).cloned();
        if let Some(tool) = tool {
            let finalized = tool.finalized;
            let uncertain = tool.uncertain_shell;
            if finalized
                && !uncertain
                && pending_child.is_none()
                && !definition_changed
                && !new_error
                && prior_status.as_deref() == Some(tool.status.as_str())
            {
                state.notice(facts, frame, "session/update", None, Some(agent_key));
                let is_shell = tool_detail(&Value::Object(tool.data.clone()), state.quirks)
                    .get("kind")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind == "shell");
                if is_shell {
                    shell_output.append(state, &tool_key, update, facts);
                }
                retire_tool(state, &tool_key);
                return true;
            }
        }
    }
    if retained_raw {
        state.notice(facts, frame, "session/update", None, Some(agent_key));
    }
    // Open the turn for live work.
    {
        let (has_task, agent_active) = (
            state
                .tools
                .get(&tool_key)
                .and_then(|tool| tool.task.clone())
                .is_some(),
            if agent_key == state.root.key {
                state.root.active
            } else {
                state
                    .agents
                    .values()
                    .find(|agent| agent.key == *agent_key)
                    .is_some_and(|agent| agent.active)
            },
        );
        if !has_task
            && (live || agent_active)
            && (prior_status.is_none()
                || live
                || !state
                    .tools
                    .get(&tool_key)
                    .is_some_and(|tool| tool.finalized))
        {
            if agent_key == state.root.key && !state.prompt_open && !agent_active {
                state.root.implicit_turn = true;
            }
            let trigger = if agent_key == state.root.key {
                "unknown"
            } else {
                "spawn"
            };
            state.start(agent_key, facts, trigger);
        }
    }
    state.finish_stream(agent_key, facts);
    if agent_key == state.root.key {
        state.root.segment.clear();
    } else if let Some(agent) = state
        .agents
        .values_mut()
        .find(|agent| agent.key == *agent_key)
    {
        agent.segment.clear();
    }
    let (detail, live_snapshot) = {
        let quirks = state.quirks;
        let live_now = state.live_tools.contains(&tool_key);
        let detail = if live_now {
            state
                .tools
                .get(&tool_key)
                .map(|tool| current_tool_detail(tool, quirks))
                .unwrap_or(Value::Null)
        } else {
            state
                .tools
                .get_mut(&tool_key)
                .map(|tool| finalize_tool(tool, quirks))
                .unwrap_or(Value::Null)
        };
        (detail, live_now)
    };
    if let Some(digest) = error_digest
        && let Some(tool) = state.tools.get_mut(&tool_key)
    {
        tool.published_error = Some(digest);
    }
    crate::translate::update_finish::push_upsert(
        state,
        agent_key,
        &tool_key,
        &detail,
        error,
        retained_raw,
        facts,
    );
    crate::translate::update_finish::settle_finish(
        state,
        shell_output,
        agent_key,
        &tool_key,
        update,
        &detail,
        facts,
    );
    let _ = live_snapshot;
    true
}
