// SPDX-License-Identifier: Apache-2.0
//! Incoming permission requests (`requests.ts`).

use crate::translate::completed_tools::retire_tool;
use crate::translate::data::{object, raw, string};
use crate::translate::interactions::interaction_key;
use crate::translate::settlement::{answer_is_neutral, answer_refuses_tool};
use crate::translate::state::TranslationState;
use crate::translate::tool_final::finalize_tool;
use crate::translate::tool_raw::retain_tool_raw;
use serde_json::{Map, Value};

/// Open an incoming request. Returns true when the frame is handled.
pub fn open_request(
    state: &mut TranslationState,
    shell_output: &mut crate::translate::shell_output::ShellOutput,
    id: &crate::translate::data::RpcId,
    method: &str,
    params: &Map<String, Value>,
    frame: &Value,
    facts: &mut Vec<Value>,
) -> bool {
    let key = crate::translate::state::rpc_key(id);
    if state.requests.contains_key(&key) {
        state.notice(facts, frame, method, None, None);
        return true;
    }
    let params_value = Value::Object(params.clone());
    let request =
        crate::translate::interactions::interaction_request(method, &params_value, state.quirks);
    let native_tool = {
        let direct = string(params.get("toolCallId").unwrap_or(&Value::Null));
        if !direct.is_empty() {
            direct.to_owned()
        } else {
            string(
                object(params.get("toolCall").unwrap_or(&Value::Null))
                    .get("toolCallId")
                    .unwrap_or(&Value::Null),
            )
            .to_owned()
        }
    };
    // Resolve the tool and its owner without holding borrows across facts.
    let (tool_key, owner_key) = {
        let session_id = string(params.get("sessionId").unwrap_or(&Value::Null)).to_owned();
        if !session_id.is_empty() {
            // Ensure the agent exists (may push agent.seen facts).
            let agent_key = state.agent_key(&session_id, facts);
            let found = state.tool_mut(&agent_key, &session_id, &native_tool);
            match found {
                Some(key) => (Some(key), agent_key),
                None => {
                    let fallback = state.tool_key_for_native(&native_tool);
                    (fallback, agent_key)
                }
            }
        } else {
            let fallback = state.tool_key_for_native(&native_tool);
            let owner = fallback
                .as_ref()
                .and_then(|key| state.tools.get(key))
                .map(|tool| tool.owner_key.clone())
                .unwrap_or_else(|| state.root.key.clone());
            (fallback, owner)
        }
    };
    let Some(request_value) = request else {
        if method.starts_with("cursor/")
            && let Some(tool_key) = tool_key
        {
            let payload = raw(frame, method, None);
            let update = Value::Object(Map::new());
            // Borrow the tool mutably for raw retention.
            if let Some(tool) = state.tools.get_mut(&tool_key) {
                // Inline retain to avoid borrowing state twice.
                let mut owned = tool.clone();
                retain_tool_raw(&mut owned, payload, &update);
                *tool = owned;
            }
            let tool_snapshot = state.tools.get(&tool_key).cloned();
            if let Some(tool) = tool_snapshot {
                if tool.finalized
                    && !["pending", "running", "awaiting_approval"].contains(&tool.status.as_str())
                {
                    let owner = tool.owner_key.clone();
                    state.notice(facts, frame, method, None, Some(&owner));
                    return true;
                }
                let mut draft = Map::with_capacity(1);
                let mut call = Map::with_capacity(1);
                call.insert("raw".to_owned(), Value::Array(tool.raw.clone()));
                draft.insert("type".to_owned(), Value::String("tool_call".to_owned()));
                draft.insert("call".to_owned(), Value::Object(call));
                let mut fact = Map::with_capacity(4);
                fact.insert("type".to_owned(), Value::String("item.upsert".to_owned()));
                fact.insert("agent".to_owned(), Value::String(tool.owner_key.clone()));
                fact.insert("item".to_owned(), Value::String(tool.key.clone()));
                fact.insert("draft".to_owned(), Value::Object(draft));
                facts.push(Value::Object(fact));
                return true;
            }
        }
        return false;
    };
    // A request's own call replaces what an earlier update said.
    let call = object(params.get("toolCall").unwrap_or(&Value::Null)).clone();
    // Capture owner info for updateTool calls.
    let owner_native_for_update =
        string(params.get("sessionId").unwrap_or(&Value::Null)).to_owned();
    let owner_key_for_update = owner_key.clone();
    if !native_tool.is_empty()
        && call.keys().any(|key| key != "toolCallId")
        && state.tools.get(tool_key.as_deref().unwrap_or("")).is_some()
    {
        // The request's own call is what approving runs: it replaces what an earlier update said.
        let mut merged = call.clone();
        merged.insert("toolCallId".to_owned(), Value::String(native_tool.clone()));
        merged.insert(
            "sessionUpdate".to_owned(),
            Value::String("tool_call_update".to_owned()),
        );
        let merged_value = Value::Object(merged);
        crate::translate::update_tool::handle_tool_call(
            state,
            shell_output,
            &owner_key_for_update,
            &owner_native_for_update,
            &merged_value,
            frame,
            facts,
        );
    }
    // Synthesized tool for approval-first requests.
    let mut tool_key = tool_key;
    if tool_key.is_none()
        && let Some(synthesized) = request_tool(method, &params_value)
    {
        let owner_snapshot = owner_key.clone();
        let owner_native_snapshot = owner_native_for_update.clone();
        let synthesized_value = Value::Object(synthesized);
        crate::translate::update_tool::handle_tool_call(
            state,
            shell_output,
            &owner_snapshot,
            &owner_native_snapshot,
            &synthesized_value,
            frame,
            facts,
        );
        // Re-resolve after the update created it.
        let session_id = string(params.get("sessionId").unwrap_or(&Value::Null)).to_owned();
        if !session_id.is_empty() {
            // agent already ensured; look up tool again.
            if let Some(agent_key) = state
                .agents
                .get(&session_id)
                .map(|a| a.key.clone())
                .or_else(|| {
                    if session_id == state.root.native_id {
                        Some(state.root.key.clone())
                    } else {
                        None
                    }
                })
            {
                tool_key = state.tool_mut(&agent_key, &session_id, &native_tool);
                if tool_key.is_none() {
                    tool_key = state.tool_key_for_native(&native_tool);
                }
            } else {
                // Root or unknown session: fall back to native lookup.
                tool_key = state.tool_key_for_native(&native_tool);
            }
        } else {
            tool_key = state.tool_key_for_native(&native_tool);
        }
    }
    let interaction = interaction_key(id);
    state.requests.insert(
        key,
        crate::translate::state::RequestState {
            key: interaction.clone(),
            method: method.to_owned(),
            params: params.clone(),
            owner_key: owner_key.clone(),
            owner_native_id: string(params.get("sessionId").unwrap_or(&Value::Null)).to_owned(),
            request: request_value.clone(),
            tool_key: tool_key.clone(),
        },
    );
    if let Some(tool_key) = tool_key {
        if let Some(tool) = state.tools.get_mut(&tool_key) {
            tool.status = "awaiting_approval".to_owned();
        }
        state.live_tools.insert(tool_key.clone());
        let tool_snapshot = state.tools.get(&tool_key).cloned();
        if let Some(tool) = tool_snapshot {
            let mut draft = Map::with_capacity(2);
            draft.insert("type".to_owned(), Value::String("tool_call".to_owned()));
            let mut call = Map::with_capacity(1);
            call.insert(
                "status".to_owned(),
                Value::String("awaiting_approval".to_owned()),
            );
            draft.insert("call".to_owned(), Value::Object(call));
            let mut fact = Map::with_capacity(4);
            fact.insert("type".to_owned(), Value::String("item.upsert".to_owned()));
            fact.insert("agent".to_owned(), Value::String(owner_key.clone()));
            fact.insert("item".to_owned(), Value::String(tool.key));
            fact.insert("draft".to_owned(), Value::Object(draft));
            facts.push(Value::Object(fact));
        }
    }
    let mut fact = Map::with_capacity(7);
    fact.insert(
        "type".to_owned(),
        Value::String("interaction.opened".to_owned()),
    );
    fact.insert("agent".to_owned(), Value::String(owner_key));
    fact.insert("interaction".to_owned(), Value::String(interaction));
    fact.insert("blocking".to_owned(), Value::Bool(true));
    fact.insert("request".to_owned(), request_value);
    if let Some(tool_key) = state
        .requests
        .values()
        .next_back()
        .and_then(|req| req.tool_key.clone())
        && let Some(tool) = state.tools.get(&tool_key)
    {
        fact.insert("item".to_owned(), Value::String(tool.key.clone()));
    }
    fact.insert(
        "raw".to_owned(),
        Value::Array(vec![raw(frame, method, None)]),
    );
    facts.push(Value::Object(fact));
    true
}

/// The tool a request names, as a tool_call update.
pub fn request_tool(method: &str, params: &Value) -> Option<Map<String, Value>> {
    let params_map = object(params);
    let call = object(params_map.get("toolCall").unwrap_or(&Value::Null));
    let tool_call_id = {
        let direct = string(params_map.get("toolCallId").unwrap_or(&Value::Null));
        if !direct.is_empty() {
            direct.to_owned()
        } else {
            string(call.get("toolCallId").unwrap_or(&Value::Null)).to_owned()
        }
    };
    if tool_call_id.is_empty() {
        return None;
    }
    let mut out = Map::new();
    for (key, value) in call.iter() {
        out.insert(key.clone(), value.clone());
    }
    out.insert("toolCallId".to_owned(), Value::String(tool_call_id));
    out.insert(
        "sessionUpdate".to_owned(),
        Value::String("tool_call".to_owned()),
    );
    let kind = string(call.get("kind").unwrap_or(&Value::Null));
    out.insert(
        "kind".to_owned(),
        Value::String(if kind.is_empty() {
            "other".to_owned()
        } else {
            kind.to_owned()
        }),
    );
    let title = string(call.get("title").unwrap_or(&Value::Null));
    out.insert(
        "title".to_owned(),
        Value::String(if title.is_empty() {
            method.to_owned()
        } else {
            title.to_owned()
        }),
    );
    let status = string(call.get("status").unwrap_or(&Value::Null));
    out.insert(
        "status".to_owned(),
        Value::String(if status.is_empty() {
            "pending".to_owned()
        } else {
            status.to_owned()
        }),
    );
    Some(out)
}

/// Answer an open request. Returns true when the frame is handled.
pub fn answer_request(
    state: &mut TranslationState,
    id: &crate::translate::data::RpcId,
    result: &Value,
    frame: &Value,
    facts: &mut Vec<Value>,
) -> bool {
    let key = crate::translate::state::rpc_key(id);
    let Some(pending) = state.requests.shift_remove(&key) else {
        return false;
    };
    let result_map = object(result);
    let resolution = crate::translate::interactions::decode_resolution(
        &pending.method,
        &Value::Object(pending.params.clone()),
        result,
        &pending.request,
    );
    let cancelled = object(result_map.get("outcome").unwrap_or(&Value::Null))
        .get("outcome")
        .and_then(Value::as_str)
        .is_some_and(|outcome| outcome == "cancelled");
    let mut closed = Map::with_capacity(4);
    closed.insert(
        "type".to_owned(),
        Value::String("interaction.closed".to_owned()),
    );
    closed.insert("interaction".to_owned(), Value::String(pending.key.clone()));
    closed.insert(
        "state".to_owned(),
        Value::String(if cancelled {
            "cancelled".to_owned()
        } else {
            "resolved".to_owned()
        }),
    );
    if let Some(resolution) = resolution.clone() {
        closed.insert("resolution".to_owned(), resolution);
    }
    facts.push(Value::Object(closed));
    if let Some(tool_key) = pending.tool_key {
        let request_kind = pending
            .request
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("");
        let request_options: Vec<Value> = pending
            .request
            .get("options")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let declined =
            answer_refuses_tool(request_kind, &request_options, resolution.as_ref(), false);
        let neutral = answer_is_neutral(request_kind, &request_options, resolution.as_ref());
        let status = if declined {
            "declined"
        } else if cancelled {
            "cancelled"
        } else if neutral {
            "pending"
        } else {
            "running"
        };
        let settled = status != "running";
        if let Some(tool) = state.tools.get_mut(&tool_key) {
            tool.declined = declined;
            tool.status = status.to_owned();
        }
        if settled {
            state.live_tools.shift_remove(&tool_key);
        } else {
            state.live_tools.insert(tool_key.clone());
        }
        let payload = raw(frame, &pending.method, None);
        let update = Value::Object(Map::new());
        if let Some(tool) = state.tools.get_mut(&tool_key) {
            let mut owned = tool.clone();
            retain_tool_raw(&mut owned, payload, &update);
            *tool = owned;
        }
        let detail = if settled {
            let quirks = state.quirks;
            state
                .tools
                .get_mut(&tool_key)
                .map(|tool| finalize_tool(tool, quirks))
        } else {
            None
        };
        if let Some(tool) = state.tools.get(&tool_key) {
            let mut call = Map::with_capacity(3);
            call.insert("status".to_owned(), Value::String(status.to_owned()));
            if let Some(detail) = detail {
                call.insert("detail".to_owned(), detail);
            }
            call.insert("raw".to_owned(), Value::Array(tool.raw.clone()));
            let mut draft = Map::with_capacity(3);
            draft.insert("type".to_owned(), Value::String("tool_call".to_owned()));
            draft.insert("complete".to_owned(), Value::Bool(settled));
            draft.insert("call".to_owned(), Value::Object(call));
            let mut fact = Map::with_capacity(4);
            fact.insert("type".to_owned(), Value::String("item.upsert".to_owned()));
            fact.insert("agent".to_owned(), Value::String(pending.owner_key.clone()));
            fact.insert("item".to_owned(), Value::String(tool.key.clone()));
            fact.insert("draft".to_owned(), Value::Object(draft));
            facts.push(Value::Object(fact));
        }
        retire_tool(state, &tool_key);
    }
    true
}
