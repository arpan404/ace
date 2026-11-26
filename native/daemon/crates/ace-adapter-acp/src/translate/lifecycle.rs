// SPDX-License-Identifier: Apache-2.0
//! Turn ends and implicit turns (`lifecycle.ts`).

use crate::translate::child_spawn::placeholder_child;
use crate::translate::completed_tools::retire_tool;
use crate::translate::data::object;
use crate::translate::settlement::{
    cancellation_deadline, shell_carried_across_turns, shell_survives_prompt,
};
use crate::translate::state::TranslationState;
use crate::translate::tools::tool_detail;
use ace_json::{Map, Value};

const CUT_OFF: &[(&str, &str)] = &[
    (
        "max_tokens",
        "The agent stopped early: it reached its output token limit.",
    ),
    (
        "max_turn_requests",
        "The agent stopped early: it reached its limit of model requests for one turn.",
    ),
];

/// End a prompt, settling live tools and closing requests.
pub fn end_prompt(
    state: &mut TranslationState,
    agent_key: &str,
    reason: &str,
    error: &Value,
    now: i64,
    facts: &mut Vec<Value>,
) {
    state.prompt_open = false;
    if let Some(agent) = state.agent_by_key_mut(agent_key) {
        agent.suspended = false;
    }
    let cancelled = reason == "cancelled";
    let live: Vec<String> = state.live_tools.iter().cloned().collect();
    for tool_key in live {
        let tool_snapshot = state.tools.get(&tool_key).cloned();
        let Some(tool) = tool_snapshot else {
            continue;
        };
        if !["pending", "running", "awaiting_approval"].contains(&tool.status.as_str()) {
            continue;
        }
        if tool.carried {
            continue;
        }
        if tool.owner_key != *agent_key && !cancelled {
            continue;
        }
        let detail = tool_detail(&tool.data, state.quirks);
        let detail_kind = detail
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if detail_kind == "shell"
            && shell_survives_prompt(state.quirks.provider(), reason, &tool.status)
        {
            let carried = shell_carried_across_turns(state.quirks.provider(), reason, &tool.status);
            if carried && let Some(tool) = state.tools.get_mut(&tool_key) {
                tool.carried = true;
            }
            let has_task = state
                .tools
                .get(&tool_key)
                .and_then(|tool| tool.task.clone());
            if has_task.is_none() {
                let task = state.key("background");
                if let Some(tool) = state.tools.get_mut(&tool_key) {
                    tool.task = Some(task.clone());
                }
                let title = state
                    .tools
                    .get(&tool_key)
                    .and_then(|tool| tool.data.get("title"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let raw = state
                    .tools
                    .get(&tool_key)
                    .map(|tool| tool.raw.clone())
                    .unwrap_or_default();
                let mut started = Map::with_capacity(9);
                started.insert(
                    "type".to_owned(),
                    Value::from("background.started".to_owned()),
                );
                started.insert("agent".to_owned(), Value::from(tool.owner_key.clone()));
                started.insert("task".to_owned(), Value::from(task));
                started.insert("kind".to_owned(), Value::from("shell".to_owned()));
                started.insert("title".to_owned(), Value::from(title));
                let item_key = state
                    .tools
                    .get(&tool_key)
                    .map(|tool| tool.key.clone())
                    .unwrap_or_default();
                started.insert("item".to_owned(), Value::from(item_key));
                started.insert("stoppable".to_owned(), Value::Bool(false));
                if carried {
                    started.insert("endsWithSession".to_owned(), Value::Bool(true));
                } else {
                    started.insert("blocksPrompts".to_owned(), Value::Bool(true));
                }
                started.insert("raw".to_owned(), Value::from(raw));
                facts.push(Value::Object(started));
            }
            if !cancelled {
                continue;
            }
            state.retain_uncertain_shell(&tool_key);
            if let Some(task) = state
                .tools
                .get(&tool_key)
                .and_then(|tool| tool.task.clone())
            {
                let mut ended = Map::with_capacity(4);
                ended.insert(
                    "type".to_owned(),
                    Value::from("background.ended".to_owned()),
                );
                ended.insert("task".to_owned(), Value::from(task));
                ended.insert("status".to_owned(), Value::from("unknown".to_owned()));
                ended.insert("uncertain".to_owned(), Value::Bool(true));
                facts.push(Value::Object(ended));
            }
        }
        let has_terminal_child = state
            .tools
            .get(&tool_key)
            .and_then(|tool| tool.child_key.clone())
            .is_some_and(|child_key| {
                let child_native = state
                    .tools
                    .get(&tool_key)
                    .and_then(|tool| tool.child_native_id.clone());
                // Placeholder children have no native session; other children end with updates.
                let is_placeholder = state.tools.get(&tool_key).is_some_and(|_| {
                    child_native
                        .as_ref()
                        .and_then(|id| state.agents.get(id))
                        .is_some_and(|child| child.placeholder)
                });
                if is_placeholder {
                    return false;
                }
                // Non-placeholder children: skip ending when the child isn't terminal.
                let _ = child_key;
                child_native
                    .as_ref()
                    .and_then(|id| state.agents.get(id))
                    .is_some_and(|child| !child.terminal)
            });
        if !cancelled && has_terminal_child {
            continue;
        }
        let quirks = state.quirks;
        let final_detail = state
            .tools
            .get_mut(&tool_key)
            .map(|tool| crate::translate::tool_final::finalize_tool(tool, quirks));
        if let Some(tool) = state.tools.get_mut(&tool_key) {
            tool.status = "cancelled".to_owned();
        }
        state.live_tools.shift_remove(&tool_key);
        if let Some(detail) = final_detail {
            let tool_snapshot = state.tools.get(&tool_key).cloned();
            if let Some(tool) = tool_snapshot {
                let mut draft = Map::with_capacity(2);
                draft.insert("type".to_owned(), Value::from("tool_call".to_owned()));
                let mut call = Map::with_capacity(4);
                call.insert("status".to_owned(), Value::from("cancelled".to_owned()));
                call.insert(
                    "error".to_owned(),
                    Value::from("turn ended without completion".to_owned()),
                );
                call.insert("detail".to_owned(), detail);
                call.insert("raw".to_owned(), Value::from(tool.raw.clone()));
                // Order: type, complete, call{status, error, detail, raw}.
                // TS inserts: type, complete, call{status, error, detail, raw}
                // via object literal order.
                let mut ordered_call = Map::with_capacity(4);
                ordered_call.insert("status".to_owned(), Value::from("cancelled".to_owned()));
                ordered_call.insert(
                    "error".to_owned(),
                    Value::from("turn ended without completion".to_owned()),
                );
                if let Some(detail) = call.get("detail") {
                    ordered_call.insert("detail".to_owned(), detail.clone());
                }
                if let Some(raw) = call.get("raw") {
                    ordered_call.insert("raw".to_owned(), raw.clone());
                }
                draft.insert("complete".to_owned(), Value::Bool(true));
                draft.insert("call".to_owned(), Value::Object(ordered_call));
                // Rebuild draft in type, complete, call order (already).
                let mut fact = Map::with_capacity(4);
                fact.insert("type".to_owned(), Value::from("item.upsert".to_owned()));
                fact.insert("agent".to_owned(), Value::from(tool.owner_key.clone()));
                fact.insert("item".to_owned(), Value::from(tool.key.clone()));
                fact.insert("draft".to_owned(), Value::Object(draft));
                facts.push(Value::Object(fact));
            }
        }
        // Placeholder children end with their tool.
        let has_placeholder_child = state
            .tools
            .get(&tool_key)
            .and_then(|tool| tool.child_native_id.clone())
            .and_then(|native_id| state.agents.get(&native_id))
            .is_some_and(|child| child.placeholder);
        if has_placeholder_child {
            placeholder_child(state, &tool_key, facts);
        }
        retire_tool(state, &tool_key);
    }
    // Stray sessions end with the root's prompt.
    if agent_key == state.root.key {
        let stray_keys: Vec<ace_json::JsString> = state
            .agents
            .values()
            .filter(|child| {
                child.key != state.root.key
                    && !child.associated
                    && !child.placeholder
                    && !child.terminal
            })
            .map(|child| child.native_id.clone())
            .collect();
        for native_id in stray_keys {
            let (active, key) = state
                .agents
                .get(&native_id)
                .map(|child| (child.active, child.key.clone()))
                .unwrap_or((false, String::new()));
            if active {
                let outcome = if cancelled || reason.is_empty() {
                    "interrupted"
                } else {
                    "completed"
                };
                state.end(&key, facts, outcome, None);
            }
            if let Some(child) = state.agents.get_mut(&native_id) {
                child.terminal = true;
            }
            // disarm by agent key
            state.disarm_cancel(&key);
        }
    }
    let mut cancelling = false;
    if cancelled {
        let children: Vec<String> = state
            .agents
            .values()
            .filter(|child| child.key != state.root.key && !child.terminal)
            .map(|child| child.key.clone())
            .collect();
        let deadline = cancellation_deadline(now);
        for child_key in children {
            state.arm_cancel(&child_key, deadline);
            cancelling = true;
        }
    }
    if cancelling {
        let until = cancellation_deadline(now);
        let mut wake = Map::with_capacity(3);
        wake.insert("type".to_owned(), Value::from("wake.expected".to_owned()));
        wake.insert("agent".to_owned(), Value::from(agent_key.to_owned()));
        wake.insert("until".to_owned(), Value::from(until));
        facts.push(Value::Object(wake));
    }
    // Close open permission requests.
    let open: Vec<ace_json::JsString> = state
        .requests
        .iter()
        .filter(|(_, request)| cancelled || request.owner_key == *agent_key)
        .map(|(id, _)| id.clone())
        .collect();
    for id in open {
        if let Some(pending) = state.requests.shift_remove(&id) {
            let mut closed = Map::with_capacity(3);
            closed.insert(
                "type".to_owned(),
                Value::from("interaction.closed".to_owned()),
            );
            closed.insert("interaction".to_owned(), Value::from(pending.key.clone()));
            closed.insert("state".to_owned(), Value::from("cancelled".to_owned()));
            facts.push(Value::Object(closed));
        }
    }
    let segment = state
        .agent_by_key(agent_key)
        .map(|agent| agent.segment.clone())
        .unwrap_or_default();
    let classified = state.quirks.classify_error(&segment).or_else(|| {
        if reason == "refusal" {
            let mut error = Map::with_capacity(3);
            error.insert("kind".to_owned(), Value::from("provider".to_owned()));
            error.insert("code".to_owned(), Value::from("refusal".to_owned()));
            error.insert(
                "message".to_owned(),
                Value::from("Provider refused the prompt".to_owned()),
            );
            Some(Value::Object(error))
        } else {
            None
        }
    });
    let error_is_empty = object(error).is_empty();
    let classified = classified.or_else(|| {
        if error_is_empty {
            None
        } else {
            let error_map = object(error);
            let code = error_map.get("code").and_then(Value::as_i64);
            let kind = if code == Some(-32000) {
                "auth"
            } else {
                "provider"
            };
            let message = error_map
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let message = if message.is_empty() {
                "ACP prompt failed".to_owned()
            } else {
                message
            };
            let mut map = Map::with_capacity(2);
            map.insert("kind".to_owned(), Value::from(kind.to_owned()));
            map.insert("message".to_owned(), Value::from(message));
            Some(Value::Object(map))
        }
    });
    let has_error = classified.is_some();
    state.end(
        agent_key,
        facts,
        if cancelled {
            "interrupted"
        } else if has_error {
            "failed"
        } else {
            "completed"
        },
        classified,
    );
    let limit = if has_error {
        None
    } else {
        CUT_OFF
            .iter()
            .find(|(code, _)| *code == reason)
            .map(|(_, text)| *text)
    };
    if let Some(text) = limit {
        let stop_key = state.key("stop");
        let mut draft = Map::with_capacity(6);
        draft.insert("type".to_owned(), Value::from("notice".to_owned()));
        draft.insert("complete".to_owned(), Value::Bool(true));
        draft.insert("level".to_owned(), Value::from("warning".to_owned()));
        draft.insert("code".to_owned(), Value::from(reason.to_owned()));
        draft.insert("text".to_owned(), Value::from(text.to_owned()));
        let mut fact = Map::with_capacity(4);
        fact.insert("type".to_owned(), Value::from("item.upsert".to_owned()));
        fact.insert("agent".to_owned(), Value::from(agent_key.to_owned()));
        fact.insert("item".to_owned(), Value::from(stop_key));
        fact.insert("draft".to_owned(), Value::Object(draft));
        facts.push(Value::Object(fact));
    }
}
